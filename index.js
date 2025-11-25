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

// -------------------------------------------------------------
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

// -------------------------------------------------------------
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

// -------------------------------------------------------------
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

// -------------------------------------------------------------
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

        const candidates = [];

        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k in o) {
            const v = o[k];

            if (
              k.toLowerCase().includes("price") ||
              k.toLowerCase().includes("amount") ||
              k.toLowerCase().includes("value")
            ) {
              if (typeof v === "string" || typeof v === "number") {
                candidates.push(String(v));
              }
            }

            if (typeof v === "object") walk(v);
          }
        };

        walk(json);

        candidates.forEach((p) => prices.push(p));
      }
    } catch (e) {}
  });

  return () => prices;
}

// -------------------------------------------------------------
function normalizePrice(raw) {
  if (!raw) return null;

  let txt = String(raw)
    .replace(/\s+/g, "")
    .replace("R$", "")
    .replace(/[^0-9.,]/g, "");

  if (txt.includes(".")) {
    const parts = txt.split(".");
    if (parts.length > 2) {
      txt = parts.join("");
    } else if (parts[1].length === 3) {
      txt = parts.join("");
    }
  }

  txt = txt.replace(",", ".");
  const num = Number(txt);

  if (isNaN(num) || num === 0) return null;
  return num;
}

// -------------------------------------------------------------
// 🔥 REIMPLEMENTAÇÃO ROBUSTA do finalizePrice
// usa scoring: prefira JSON-LD / meta / seletores principais / XHR / formato consistente / frequência
function finalizePrice(allValues) {
  if (!Array.isArray(allValues) || allValues.length === 0) return null;

  // normalize and keep original raw strings for scoring
  const candidates = allValues
    .map((raw) => {
      const rawStr = raw == null ? "" : String(raw).trim();
      const num = normalizePrice(rawStr);
      return { raw: rawStr, num };
    })
    .filter((c) => c.num !== null);

  if (candidates.length === 0) return null;

  // frequency map based on normalized numeric value (stringified)
  const freq = {};
  for (const c of candidates) {
    const key = c.num.toFixed(2);
    freq[key] = (freq[key] || 0) + 1;
  }

  // scoring function
  const scoreFor = (cand) => {
    let score = 0;
    const raw = cand.raw.toLowerCase();

    // 1) Source hints in the raw string
    // If raw contains explicit currency or BRL mention -> strong signal
    if (/\br\$/.test(raw) || /\bbrl\b/.test(raw)) score += 6;

    // If raw looks like meta amount (pure number) less weight
    if (/^[\d\.,]+$/.test(raw)) score += 1;

    // If raw contains words like 'de', 'por', 'à vista', 'à vista' maybe indicates final/discount
    if (/\b(vista|de|por|agora|oferta|desconto|promo|preço)\b/.test(raw)) score += 2;

    // 2) Format quality: BR format with thousands and cents (e.g., 1.234,56)
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(cand.raw)) score += 5;

    // 3) Decimal presence (has cents) is a good sign
    if (/[,\.]\d{2}$/.test(cand.raw)) score += 3;

    // 4) If raw contains "installment" or "parcela" penalize slightly (often not total)
    if (/parcela|parcelas|installment|juros/.test(raw)) score -= 3;

    // 5) Very small numbers (<2) are suspect but may be valid; penalize lightly
    if (cand.num < 2) score -= 2;

    // 6) Very large numbers are suspect; penalize (but not absolute block)
    if (cand.num > 100000) score -= 6;
    else if (cand.num > 20000) score -= 3;

    // 7) Frequency boost: values that appear multiple times (from different sources) are more reliable
    const f = freq[cand.num.toFixed(2)] || 0;
    score += Math.min(f, 5) * 2; // up to +10

    // 8) If raw contains many digits without separators (likely ID) penalize
    if (/^\d{5,}$/.test(cand.raw.replace(/[^\d]/g, "")) && !/[.,]/.test(cand.raw)) score -= 5;

    return score;
  };

  // compute scores
  const scored = candidates.map((c) => ({ ...c, score: scoreFor(c) }));

  // sort by score desc, tie-breaker by occurrence frequency then by closeness to median
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = freq[a.num.toFixed(2)] || 0;
    const fb = freq[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    return a.num - b.num; // prefer lower price if everything else equal
  });

  // top candidate(s)
  const topScore = scored[0].score;
  const topCandidates = scored.filter((s) => s.score === topScore);

  // if multiple top candidates, pick the one with the most occurrences, then the smallest numeric (to match "best price")
  topCandidates.sort((a, b) => {
    const fa = freq[a.num.toFixed(2)] || 0;
    const fb = freq[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    return a.num - b.num;
  });

  const chosen = topCandidates[0];

  // final formatting to BR currency
  const final = chosen.num;
  return `R$ ${final.toFixed(2).replace(".", ",")}`;
}

// -------------------------------------------------------------
async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    const cleaned = sanitizeIncomingUrl(rawUrl);
    console.log("URL RECEBIDA:", rawUrl);
    console.log("URL SANITIZADA:", cleaned);

    if (!cleaned) return { success: false, error: "URL inválida" };

    const browser = await puppeteer.launch({
      headless: true,
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

    try {
      await page.setUserAgent(process.env.USER_AGENT || DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({
        "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      });

      const collectXHR = createXHRPriceCollector(page);

      // NAVIGATION --------------------------------------------------------------------
      try {
        await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
      } catch {
        await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
      }

      await page.waitForTimeout(700);
      await autoScroll(page);
      await page.waitForTimeout(600);

      // SCRAPING ----------------------------------------------------------------------
      let title = null;
      let image = null;
      let rawPrices = [];

      // JSON-LD
      try {
        const blocks = await page.$$eval(
          'script[type="application/ld+json"]',
          (nodes) => nodes.map((n) => n.textContent)
        );

        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const item of arr) {
              if (!title && (item.name || item.title)) title = item.name || item.title;

              if (!image && item.image) {
                const img = Array.isArray(item.image) ? item.image[0] : item.image;
                image = typeof img === "object" ? img.url || img.contentUrl : img;
              }

              if (item.offers) {
                const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                for (const o of offers) {
                  if (o.price) rawPrices.push(o.price);
                }
              }
            }
          } catch {}
        }
      } catch {}

      // OG ---------------------------------------------
      if (!title)
        title = await page.$eval(`meta[property="og:title"]`, (e) => e.content).catch(() => null);

      if (!image)
        image = await page.$eval(`meta[property="og:image"]`, (e) => e.content).catch(() => null);

      // TÍTULO e IMAGEM fallback ------------------------
      if (!title) {
        title = await page.evaluate(() => {
          const sels = ["h1", ".product-title", ".product-name", ".pdp-title"];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return (el.innerText || el.textContent).trim();
          }
          return null;
        });
      }

      if (!image) {
        const imgs = [
          "img#product-image",
          ".product-image img",
          ".pdp-image img",
          ".gallery img",
          ".image img",
        ];

        for (const sel of imgs) {
          const src = await page.$eval(sel, (el) => el.currentSrc || el.src).catch(() => null);
          if (src) {
            image = src;
            break;
          }
        }
      }

      // PREÇOS HTML -------------------------------------
      const htmlSelectors = [
        "[itemprop='price']",
        ".price",
        ".product-price",
        ".sales-price",
        ".best-price",
        ".valor",
        ".priceFinal",
        ".productPrice",
        ".price--main",
        ".product-price-amount",
      ];

      for (const sel of htmlSelectors) {
        const txt = await page.$eval(sel, (el) => el.innerText || el.textContent || el.content).catch(
          () => null
        );
        if (txt) rawPrices.push(txt);

        const shadow = await querySelectorShadow(page, sel);
        if (shadow?.text) rawPrices.push(shadow.text);
      }

      // PREÇOS XHR ----------------------------------------
      const xhrPrices = collectXHR();
      rawPrices.push(...xhrPrices);

      // FALLBACK TEXTO ------------------------------------
      if (rawPrices.length === 0) {
        const text = await page.evaluate(() => document.body.innerText);
        const m = text.match(/R\$\s?[\d\.,]+/g);
        if (m) rawPrices.push(...m);
      }

      // FINALIZAÇÃO UNIVERSAL ------------------------------
      const finalPrice = finalizePrice(rawPrices);

      if (title && typeof title === "string")
        title = title.split("|")[0].split("-")[0].trim();

      await browser.close();

      return {
        success: true,
        url: cleaned,
        title: title || null,
        price: finalPrice || null,
        image: image || null,
      };
    } catch (err) {
      await browser.close().catch(() => {});
      return { success: false, error: err.message };
    }
  });
}

// -------------------------------------------------------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL ausente" });

    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

