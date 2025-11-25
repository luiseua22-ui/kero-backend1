import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

const queue = new PQueue({ concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2 });

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Helpers ------------------------------------------------------------

function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map(m => m[0]);
  if (matches.length > 0) return matches[0];
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).toString(); }
  catch (e) { return null; }
}

async function autoScroll(page, maxScroll = 2400) {
  await page.evaluate(async (maxScroll) => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 200;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= maxScroll || total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 130);
    });
  }, maxScroll);
}

async function querySelectorShadow(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      try {
        if (root.querySelector) {
          const found = root.querySelector(sel);
          if (found) return found;
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
        for (const n of nodes) {
          if (n.shadowRoot) {
            const r = search(n.shadowRoot);
            if (r) return r;
          }
        }
      } catch (e) {}
      return null;
    }
    const el = search(document);
    if (!el) return null;
    if (el.tagName === "IMG") return { type: "img", src: el.src || el.currentSrc || null };
    if (el.tagName === "META") return { type: "meta", content: el.content || null };
    return { type: "other", text: (el.innerText || el.textContent || "").trim() || null };
  }, selector);
}

// Coleta XHR de preços com marcação de fonte
function createXHRPriceCollector(page) {
  const prices = [];
  page.on("response", async (resp) => {
    try {
      const url = resp.url().toLowerCase();
      if (
        url.includes("price") ||
        url.includes("offer") ||
        url.includes("sku") ||
        url.includes("product") ||
        url.includes("pricing")
      ) {
        const ctype = resp.headers()["content-type"] || "";
        if (!ctype.includes("application/json")) return;
        const json = await resp.json().catch(() => null);
        if (!json) return;
        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k of Object.keys(o)) {
            const v = o[k];
            if (
              k.toLowerCase().includes("price") ||
              k.toLowerCase().includes("amount") ||
              k.toLowerCase().includes("value")
            ) {
              if (typeof v === "string" || typeof v === "number") {
                prices.push({ raw: String(v), source: "xhr" });
              }
            }
            if (typeof v === "object") walk(v);
          }
        };
        walk(json);
      }
    } catch (e) {}
  });
  return () => prices;
}

// Normaliza valor bruto de preço para número
function normalizePrice(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // detectar string de parcela (ex: "12 x R$ 609,33")
  const parcelaMatch = s.match(/(\d+)\s*x\s*R\$\s*([\d\.,]+)/i);
  if (parcelaMatch) {
    // grupo 1 = número de parcelas, grupo 2 = valor da parcela
    const numParc = Number(parcelaMatch[1]);
    const valorParc = parcelaMatch[2];
    // normaliza parcela
    let normalizedParc = valorParc.replace(/\./g, "").replace(",", ".");
    const num = parseFloat(normalizedParc);
    if (!isNaN(num)) {
      // retorna valor total: parcela * número de parcelas
      return num * numParc;
    }
  }

  // remover NBSP e símbolos
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/(r\$\s?)/i, "");
  s = s.replace(/(brl)/i, "");
  s = s.replace(/[^\d.,]/g, "");

  if (!s) return null;

  // se só dígitos (ex: "731200"), considerar como possível centavos
  if (/^\d+$/.test(s)) {
    const asInt = Number(s);
    if (asInt > 100000) {
      return asInt / 100; // interpreta como centavos
    }
    return asInt;
  }

  // lógica para ponto e vírgula
  if (s.includes(".") && s.includes(",")) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      s = s.replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(".")) {
    const parts = s.split(".");
    if (parts.length === 2 && parts[1].length === 2) {
      // ponto decimal
    } else {
      s = s.replace(/\./g, "");
    }
  }

  s = s.replace(",", ".");
  const num = Number(s);
  if (isNaN(num)) return null;

  // heurística para centavos
  if (num > 100000 && Number.isInteger(num)) {
    return num / 100;
  }

  return num;
}

// Seleção final de preço com pontuação
function finalizePrice(candidates, proximityMap = {}) {
  const mapped = candidates
    .map(c => {
      const num = normalizePrice(c.raw);
      return { raw: c.raw, num, sources: c.source, count: c.count || 1 };
    })
    .filter(c => c.num !== null && Number.isFinite(c.num));

  if (mapped.length === 0) {
    console.log("Nenhum candidato numérico válido", candidates);
    return null;
  }

  const freq = {};
  mapped.forEach(c => {
    const key = c.num.toFixed(2);
    freq[key] = (freq[key] || 0) + c.count;
  });

  const nums = [...new Set(mapped.map(c => c.num))].sort((a,b)=>a-b);
  const median = nums.length ? nums[Math.floor(nums.length / 2)] : null;

  const scored = mapped.map(c => {
    let score = 0;
    // fonte
    if (c.sources.includes("jsonld")) score += 30;
    if (c.sources.includes("selector-visible")) score += 22;
    if (c.sources.includes("selector")) score += 18;
    if (c.sources.includes("xhr")) score += 10;
    if (c.sources.includes("body")) score += 2;

    // se raw era parcela, penaliza um pouco (porque preferimos total)
    if (/x\s*R\$/i.test(c.raw)) score -= 5;

    // presença de "R$"
    if (/R\$/i.test(c.raw)) score += 6;

    // frequência
    const f = freq[c.num.toFixed(2)] || 0;
    score += Math.min(f, 5) * 3;

    // proximidade
    const prox = proximityMap[c.raw];
    if (prox) {
      if (prox.near) score += 18;
      score += Math.min(prox.count || 0, 5) * 2;
    }

    // coerência com median
    if (median && median > 0) {
      const ratio = c.num / median;
      if (ratio >= 0.2 && ratio <= 5) score += 2;
      if (ratio < 0.03) score -= 6;
      if (ratio > 20) score -= 6;
    }

    // penaliza valores muito baixos (<1 real)
    if (c.num < 1) score -= 6;

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log("CANDIDATOS PREÇO:", scored.map(s => ({ raw: s.raw, num: s.num, score: s.score })));

  const best = scored[0];
  if (!best) return null;

  return `R$ ${best.num.toFixed(2).replace(".", ",")}`;
}

// Scraper principal ------------------------------------------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    const cleaned = sanitizeIncomingUrl(rawUrl);
    console.log("URL RECEBIDA:", rawUrl);
    console.log("URL SANITIZADA:", cleaned);
    if (!cleaned) return { success: false, error: "URL inválida" };

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-features=site-per-process", "--window-size=1920,1080"],
      defaultViewport: { width: 1920, height: 1080 },
    });
    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

    const collectXHR = createXHRPriceCollector(page);

    try {
      await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
    } catch (e) {
      await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
    }

    await page.waitForTimeout(700);
    await autoScroll(page);
    await page.waitForTimeout(600);

    let title = null;
    let image = null;
    const rawCandidates = [];

    // JSON-LD
    try {
      const jsons = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
      for (const block of jsons) {
        let parsed;
        try { parsed = JSON.parse(block); }
        catch { continue; }
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr.flat()) {
          if (!title && (item.name || item.title)) title = item.name || item.title;
          if (!image && item.image) {
            const img = Array.isArray(item.image) ? item.image[0] : item.image;
            image = typeof img === "object" ? img.url || img.contentUrl : img;
          }
          if (item.offers) {
            const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
            for (const o of offers) {
              if (o.price) rawCandidates.push({ raw: String(o.price), source: "jsonld" });
            }
          }
        }
      }
    } catch {}

    // OpenGraph
    const ogTitle = await page.$eval("meta[property='og:title']", e => e.content).catch(() => null);
    if (ogTitle && !title) title = ogTitle;
    const ogImage = await page.$eval("meta[property='og:image']", e => e.content).catch(() => null);
    if (ogImage && !image) image = ogImage;

    // Selectors visíveis
    const selList = ["[itemprop='price']", ".price", ".product-price", ".sales-price", ".valor"];
    for (const sel of selList) {
      const vals = await page.$$eval(sel, els => els.map(e => (e.innerText || e.textContent || "").trim())).catch(() => []);
      for (const v of vals) {
        rawCandidates.push({ raw: v, source: "selector" });
      }
      const shadow = await querySelectorShadow(page, sel);
      if (shadow && shadow.text) rawCandidates.push({ raw: shadow.text, source: "selector" });
    }

    // XHR
    const xhrList = collectXHR();
    for (const o of xhrList) rawCandidates.push(o);

    // Corpo da página
    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (body) {
      const matches = Array.from(new Set((body.match(/R\$\s?[\d\.,]+/g) || []).map(s => s.trim())));
      for (const m of matches) rawCandidates.push({ raw: m, source: "body" });
    }

    console.log("RAW CANDIDATOS:", rawCandidates);

    // Proximidade
    const uniqueRaw = Array.from(new Set(rawCandidates.map(c => c.raw)));
    const proximityInfo = await page.evaluate((cands, titleText, imageUrl) => {
      const info = {};
      cands.forEach(c => info[c] = { near: false, count: 0 });
      const titleEls = titleText ? Array.from(document.querySelectorAll("h1, .product-title, .product-name")).filter(el => (el.innerText || el.textContent).includes(titleText)) : [];
      const imgEls = imageUrl ? Array.from(document.querySelectorAll("img")).filter(img => (img.src || img.currentSrc).includes(imageUrl)) : [];
      const ctxEls = [...titleEls, ...imgEls];
      function near(node, ctx) {
        if (!node || !ctx) return false;
        let p = node;
        for (let i = 0; i < 6 && p; i++) {
          if (ctx.includes(p)) return true;
          p = p.parentElement;
        }
        return false;
      }
      cands.forEach(c => {
        const nodes = Array.from(document.querySelectorAll("body *")).filter(n => (n.innerText || n.textContent || "").includes(c));
        info[c].count = nodes.length;
        for (const n of nodes) {
          if (near(n, ctxEls)) { info[c].near = true; break; }
        }
      });
      return info;
    }, uniqueRaw, title || "", image || "");

    // Finaliza preço
    const finalPrice = finalizePrice(rawCandidates.map(c => ({ raw: c.raw, source: c.source, count: 1 })), proximityInfo);

    if (title && typeof title === "string") title = title.split("|")[0].split("-")[0].trim();
    await browser.close();

    return {
      success: true,
      url: cleaned,
      title,
      price: finalPrice,
      image,
      rawCandidatesCount: rawCandidates.length
    };
  });
}

// Rota API
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
  const result = await scrapeProduct(url);
  res.json(result);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

