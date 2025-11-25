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

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map((m) => m[0]);
  if (matches.length > 0) return matches[0];
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).toString();
  } catch (e) {
    return null;
  }
}

async function autoScroll(page, maxScroll = 2400) {
  await page.evaluate(async (maxScroll) => {
    await new Promise((resolve) => {
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

// ------------------------------------------------------------------
// Coleta XHR de preços com marcação de fonte e detecção de parcelas
// Retorna lista de candidatos: { raw, source, isInstallment?, parcCount?, parcValue? }
// ------------------------------------------------------------------
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
        url.includes("pricing") ||
        url.includes("/item") ||
        url.includes("/products")
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
              k.toLowerCase().includes("value") ||
              k.toLowerCase().includes("total")
            ) {
              if (typeof v === "string" || typeof v === "number") {
                const text = String(v).trim();
                // Detecta parcela no texto (ex: "12 x 609.33" ou "12x de R$ 609,33")
                const parc = text.match(/(\d+)\s*x\s*R?\$?\s*([\d\.,]+)/i) || text.match(/(\d+)\s*x\s*([\d\.,]+)/i);
                if (parc) {
                  const parcCount = Number(parc[1]);
                  const parcRaw = parc[2];
                  prices.push({ raw: text, source: "xhr", isInstallment: true, parcCount, parcValueRaw: parcRaw });
                  // também empilha o total computado como candidato (importante)
                  prices.push({ raw: String(parcCount) + "x_total", source: "xhr", isInstallmentComputed: true, computedTotalRaw: `${parcCount}x${parcRaw}` });
                } else {
                  prices.push({ raw: text, source: "xhr" });
                }
              }
            }
            if (typeof v === "object") walk(v);
          }
        };

        walk(json);
      }
    } catch (e) {
      // ignore noisy errors
    }
  });

  return () => prices;
}

// ------------------------------------------------------------------
// Extrai número de string bruta e lida com centavos/milhares
// Retorna { num: Number | null, note: string }
// ------------------------------------------------------------------
function parseNumberFromString(raw) {
  if (raw === null || raw === undefined) return { num: null, note: "empty" };
  let s = String(raw).trim();

  // remove NBSP
  s = s.replace(/\u00A0/g, "");

  // remove currency sign and letters
  s = s.replace(/R\$|BRL|\$/gi, "");
  // remove non-digit,non-dot,non-comma,keep x marker for computedTotalRaw
  s = s.replace(/[^\d\.,]/g, "");

  if (!s) return { num: null, note: "no digits" };

  // Common formats:
  // 1) 7.312,00 -> '.' thousands, ',' decimal
  // 2) 7312.00 -> '.' decimal
  // 3) 731200  -> maybe cents (when no separators)
  // 4) 12.345.678 -> thousands only
  // Strategy:
  // - If contains both '.' and ',' assume '.' thousands, ',' decimal => remove dots, replace ',' with '.'
  // - Else if contains ',' only and right side length <=2 then treat ',' as decimal => replace ',' with '.'
  // - Else if contains '.' only and right side length ==2 treat '.' as decimal
  // - Else if only digits and length > 5 treat as cents => divide by 100
  try {
    if (s.includes(".") && s.includes(",")) {
      // thousands dots, decimal comma
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",") && !s.includes(".")) {
      const parts = s.split(",");
      if (parts[1] && parts[1].length <= 2) {
        s = s.replace(",", ".");
      } else {
        // ambiguous, remove commas (they might be thousands)
        s = s.replace(/,/g, "");
      }
    } else if (s.includes(".") && !s.includes(",")) {
      const parts = s.split(".");
      if (parts[1] && parts[1].length === 2) {
        // dot as decimal
        // leave as is
      } else {
        // probably thousands separators -> remove them
        s = s.replace(/\./g, "");
      }
    }

    // final cleanup
    s = s.replace(/[^0-9.]/g, "");
    if (!s) return { num: null, note: "cleaned empty" };

    const n = Number(s);
    if (Number.isFinite(n)) {
      if (n > 100000 && /^(\d{6,})$/.test(s.replace(".", ""))) {
        // example '731200' probably cents -> 7312.00? we attempt cent heuristic
        return { num: n / 100, note: "cent heuristic" };
      }
      return { num: n, note: "parsed" };
    }
    return { num: null, note: "not finite" };
  } catch (e) {
    return { num: null, note: "error" };
  }
}

// ------------------------------------------------------------------
// Detecta se uma string representa parcela (ex: "12 x R$ 609,33" ou "12x de 609,33")
// ------------------------------------------------------------------
function detectInstallment(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || s.match(/(\d+)\s*[xX]\s*(?:de\s*)?([\d\.,]+)/i);
  if (!m) return null;
  const count = Number(m[1]);
  const valueRaw = m[2];
  const parsed = parseNumberFromString(valueRaw);
  if (parsed.num && count > 0) {
    return { count, value: parsed.num, total: parsed.num * count };
  }
  return null;
}

// ------------------------------------------------------------------
// Escolhe o melhor preço entre candidatos complexos
// Cada candidato: { raw, source, isInstallment?, isInstallmentComputed?, parcCount?, parcValueRaw?, computedTotalRaw? }
// ------------------------------------------------------------------
function finalizePrice(candidates, proximityMap = {}) {
  // Normalize candidate objects into scored entries
  const entries = [];

  for (const c of candidates) {
    try {
      // if it's an xhr computed total marker like "12x_total" with computedTotalRaw present, handle below
      if (c.isInstallmentComputed && c.computedTotalRaw) {
        // computedTotalRaw example: "12x609,33" -> extract and compute
        const inst = detectInstallment(c.computedTotalRaw);
        if (inst && inst.total) {
          entries.push({ raw: c.computedTotalRaw, num: inst.total, source: c.source, computedTotal: true });
        }
        continue;
      }

      // direct installment info from xhr: isInstallment true with parcCount and parcValueRaw
      if (c.isInstallment && c.parcCount && c.parcValueRaw) {
        const parcParsed = parseNumberFromString(c.parcValueRaw);
        if (parcParsed.num) {
          const total = parcParsed.num * Number(c.parcCount);
          // push both: the raw parcel (low weight) and the computed total (higher weight)
          entries.push({ raw: c.raw, num: parcParsed.num, source: c.source, isParcel: true, parcelCount: c.parcCount });
          entries.push({ raw: `${c.parcCount}x_total_${c.parcValueRaw}`, num: total, source: c.source, computedTotal: true });
        }
        continue;
      }

      // otherwise try detect installment in raw string
      const inst = detectInstallment(c.raw);
      if (inst && inst.total) {
        // push computed total candidate (high priority), and keep parcel as low-priority
        entries.push({ raw: c.raw + "_parcel", num: inst.value, source: c.source, isParcel: true, parcelCount: inst.count });
        entries.push({ raw: c.raw + "_total", num: inst.total, source: c.source, computedTotal: true });
        continue;
      }

      // normal parse
      const parsed = parseNumberFromString(c.raw);
      if (parsed.num) {
        entries.push({ raw: c.raw, num: parsed.num, source: c.source, note: parsed.note });
      }
    } catch (e) {
      // ignore candidate
    }
  }

  // Filter numeric, positive
  const numeric = entries.filter((e) => typeof e.num === "number" && isFinite(e.num) && e.num > 0);

  if (numeric.length === 0) {
    console.log("Nenhum candidato válido:", candidates);
    return null;
  }

  // Frequency map by value (to favor repeated values)
  const freq = {};
  numeric.forEach((e) => {
    const key = Number(e.num).toFixed(2);
    freq[key] = (freq[key] || 0) + 1;
  });

  // Score each candidate with heuristics:
  // - computedTotal gets big boost
  // - source jsonld / selector visible get boosts
  // - freq increases score
  // - parcel raw values penalized
  // - proximity info (if provided) adds score
  const scored = numeric.map((e) => {
    let score = 0;
    // source weighting
    if (e.source && e.source.includes("jsonld")) score += 40;
    if (e.source && e.source.includes("selector")) score += 20;
    if (e.source && e.source.includes("xhr")) score += 10;
    if (e.source && e.source.includes("body")) score += 2;

    // computed totals get strong boost
    if (e.computedTotal) score += 45;

    // parcel raw penalize
    if (e.isParcel) score -= 15;

    // frequency
    const f = freq[Number(e.num).toFixed(2)] || 0;
    score += Math.min(f, 5) * 5;

    // proximity: if the exact raw string has info in proximityMap (near product title/image), boost
    const prox = proximityMap[e.raw] || proximityMap[String(e.raw)] || null;
    if (prox) {
      if (prox.near) score += 18;
      score += Math.min(prox.count || 0, 5) * 2;
    }

    // coherence heuristic: avoid absurds relative to median
    // compute median of unique nums
    return { ...e, score };
  });

  // sort by score desc, tie-breaker by numeric value closeness to max (prefer higher real price)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.num - a.num;
  });

  // log candidates for debugging
  try {
    console.log("CANDIDATOS (num,score,raw,source):", scored.map(s => ({ num: s.num, score: s.score, raw: s.raw, source: s.source })));
  } catch (e) {}

  const best = scored[0];
  if (!best) return null;

  return `R$ ${Number(best.num).toFixed(2).replace(".", ",")}`;
}

// ------------------------------------------------------------------
// Scraper principal
// ------------------------------------------------------------------
async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    const cleaned = sanitizeIncomingUrl(rawUrl);
    console.log("URL RECEBIDA:", rawUrl);
    console.log("URL SANITIZADA:", cleaned);

    if (!cleaned) return { success: false, error: "URL inválida" };

    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=site-per-process",
        "--window-size=1920,1080",
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(process.env.USER_AGENT || DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

    const collectXHR = createXHRPriceCollector(page);

    try {
      try {
        await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
      } catch (err) {
        console.warn("networkidle2 falhou, tentando domcontentloaded:", err.message || err);
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
          try { parsed = JSON.parse(block); } catch { parsed = null; }
          if (!parsed) continue;
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
                if (o.price) {
                  rawCandidates.push({ raw: String(o.price), source: "jsonld" });
                }
                // sometimes offers have priceSpecification or priceCurrency
                if (o.priceSpecification && typeof o.priceSpecification === "object") {
                  const priceSpec = o.priceSpecification.price || o.priceSpecification.priceComponent || o.priceSpecification.minPrice || o.priceSpecification.maxPrice;
                  if (priceSpec) rawCandidates.push({ raw: String(priceSpec), source: "jsonld" });
                }
              }
            }
          }
        }
      } catch (e) {
        // ignore parse errors
      }

      // OpenGraph fallback
      const ogTitle = await page.$eval("meta[property='og:title']", e => e.content).catch(() => null);
      if (ogTitle && !title) title = ogTitle;
      const ogImage = await page.$eval("meta[property='og:image']", e => e.content).catch(() => null);
      if (ogImage && !image) image = ogImage;

      // HTML selectors (visible)
      const selList = ["[itemprop='price']", ".price", ".product-price", ".sales-price", ".valor", ".priceFinal", ".productPrice", ".price--main", ".product-price-amount"];
      for (const sel of selList) {
        const vals = await page.$$eval(sel, els => els.map(e => (e.getAttribute('content') || e.innerText || e.textContent || '').trim()).filter(Boolean)).catch(() => []);
        for (const v of vals) rawCandidates.push({ raw: v, source: "selector" });

        const shadow = await querySelectorShadow(page, sel);
        if (shadow && shadow.text) rawCandidates.push({ raw: shadow.text, source: "selector" });
      }

      // XHR candidates
      const xhrList = collectXHR();
      for (const o of xhrList) {
        // o may be string or object: ensure object form
        if (typeof o === "string") rawCandidates.push({ raw: o, source: "xhr" });
        else rawCandidates.push(o);
      }

      // Body fallback: capture "R$ 1.234,56" patterns but mark source 'body'
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (body) {
        const matches = Array.from(new Set((body.match(/(?:R\$|\b)\s?[\d\.,]{2,}/g) || []).map(s => s.trim())));
        for (const m of matches) rawCandidates.push({ raw: m, source: "body" });
      }

      // remove empties and duplicates (keep source variety)
      const seen = new Set();
      const dedup = [];
      for (const c of rawCandidates) {
        if (!c || !c.raw) continue;
        const key = `${String(c.raw).trim()}|${c.source || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(c);
      }

      // Build proximity map (help scoring)
      const uniqueRaw = Array.from(new Set(dedup.map(c => String(c.raw))));
      const proximityInfo = await page.evaluate((cands, titleText, imageUrl) => {
        const info = {};
        cands.forEach(c => (info[c] = { near: false, count: 0 }));
        const titleEls = titleText ? Array.from(document.querySelectorAll("h1, .product-title, .product-name")).filter(el => (el.innerText || el.textContent || "").includes(titleText)) : [];
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

      // Final price selection
      const finalPrice = finalizePrice(dedup, proximityInfo);

      if (title && typeof title === "string") title = title.split("|")[0].split("-")[0].trim();
      await browser.close();

      return {
        success: true,
        url: cleaned,
        title: title || null,
        price: finalPrice || null,
        image: image || null,
        rawCandidatesCount: dedup.length
      };
    } catch (err) {
      await browser.close().catch(() => {});
      return { success: false, error: String(err) };
    }
  });
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL ausente" });

    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// ------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

