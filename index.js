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

// ---------------- helpers ----------------

function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map((m) => m[0]);
  if (matches.length > 0) return matches[0];
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).toString(); } catch (e) { return null; }
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

// ---------------- XHR collector ----------------
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
                // detect parcel pattern and store structured info if found
                const parc = text.match(/(\d+)\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || text.match(/(\d+)\s*[xX]\s*(?:de\s*)?([\d\.,]+)/i);
                if (parc) {
                  prices.push({ raw: text, source: "xhr", isInstallment: true, parcelCount: Number(parc[1]), parcelValueRaw: parc[2] });
                  // add computed total candidate too
                  prices.push({ raw: `${parc[1]}x_total_${parc[2]}`, source: "xhr", isInstallmentComputed: true, computedFrom: { count: Number(parc[1]), rawValue: parc[2] } });
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
    } catch (e) {}
  });
  return () => prices;
}

// ---------------- parsing number ----------------
function parseNumberFromString(raw) {
  if (raw === null || raw === undefined) return { num: null, note: "empty" };
  let s = String(raw).trim();
  s = s.replace(/\u00A0/g, "");
  // keep only digits, dots and commas and 'x' for special markers
  // remove currency letters
  s = s.replace(/R\$|BRL|\$/gi, "");
  // remove everything except digits, dot, comma
  s = s.replace(/[^0-9\.,]/g, "");
  if (!s) return { num: null, note: "no digits" };

  try {
    if (s.includes(".") && s.includes(",")) {
      // format 1.234,56
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",") && !s.includes(".")) {
      const parts = s.split(",");
      if (parts[1] && parts[1].length <= 2) s = s.replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (s.includes(".") && !s.includes(",")) {
      const parts = s.split(".");
      if (!(parts[1] && parts[1].length === 2)) s = s.replace(/\./g, "");
    }

    s = s.replace(/[^0-9.]/g, "");
    if (!s) return { num: null, note: "cleaned empty" };
    const n = Number(s);
    if (!Number.isFinite(n)) return { num: null, note: "not finite" };

    // if too large with no separators interpret as cents (heuristic)
    const digitsOnly = s.replace(".", "");
    if (/^\d+$/.test(digitsOnly) && digitsOnly.length >= 6 && n > 100000) {
      // e.g., 731200 -> 7312.00
      return { num: n / 100, note: "cent heuristic" };
    }
    return { num: n, note: "parsed" };
  } catch (e) {
    return { num: null, note: "error" };
  }
}

// ---------------- installment detect ----------------
function detectInstallment(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(\d+)\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || s.match(/(\d+)\s*[xX]\s*(?:de\s*)?([\d\.,]+)/i);
  if (!m) return null;
  const count = Number(m[1]);
  const valueRaw = m[2];
  const parsed = parseNumberFromString(valueRaw);
  if (parsed.num && count > 0) return { count, value: parsed.num, total: parsed.num * count };
  return null;
}

// ---------------- isInstallment quick check ----------------
function isInstallmentString(raw) {
  if (!raw) return false;
  const s = String(raw).toLowerCase();
  return /(\d+)\s*x|parcel|parcela|vezes/i.test(s);
}

// ---------------- final selection (robust) ----------------
function finalizePrice(candidates, proximityMap = {}) {
  // candidates: array of { raw, source, ...maybe isInstallment or isInstallmentComputed... }
  const entries = [];

  for (const c of candidates) {
    if (!c || !c.raw) continue;
    try {
      // computed installment marker
      if (c.isInstallmentComputed && c.computedFrom) {
        const parsed = parseNumberFromString(c.computedFrom.rawValue);
        if (parsed.num) {
          const total = parsed.num * Number(c.computedFrom.count);
          entries.push({ raw: c.raw, num: total, source: c.source || "xhr", computedTotal: true });
        }
        continue;
      }

      // structured installment from XHR
      if (c.isInstallment && c.parcelCount && c.parcelValueRaw) {
        const pv = parseNumberFromString(c.parcelValueRaw);
        if (pv.num) {
          const total = pv.num * Number(c.parcelCount);
          entries.push({ raw: c.raw + "_parcel_value", num: pv.num, source: c.source || "xhr", isParcel: true, parcelCount: c.parcelCount });
          entries.push({ raw: c.raw + "_parcel_total", num: total, source: c.source || "xhr", computedTotal: true });
        }
        continue;
      }

      // try detect installment inside raw
      const inst = detectInstallment(c.raw);
      if (inst && inst.total) {
        entries.push({ raw: c.raw + "_inst_parcel", num: inst.value, source: c.source || "mixed", isParcel: true, parcelCount: inst.count });
        entries.push({ raw: c.raw + "_inst_total", num: inst.total, source: c.source || "mixed", computedTotal: true });
        continue;
      }

      // normal parse
      const parsed = parseNumberFromString(c.raw);
      if (parsed.num) entries.push({ raw: c.raw, num: parsed.num, source: c.source || "unknown", note: parsed.note });
    } catch (e) {
      // ignore
    }
  }

  const numeric = entries.filter(e => typeof e.num === "number" && Number.isFinite(e.num) && e.num > 0);
  if (numeric.length === 0) {
    console.log("No numeric candidates:", candidates);
    return null;
  }

  // build frequency map
  const freq = {};
  numeric.forEach(e => { const k = Number(e.num).toFixed(2); freq[k] = (freq[k] || 0) + 1; });

  // compute median for coherence checks
  const uniqueNums = Array.from(new Set(numeric.map(e => e.num))).sort((a,b)=>a-b);
  const median = uniqueNums.length ? uniqueNums[Math.floor(uniqueNums.length/2)] : null;
  const maxValue = Math.max(...numeric.map(n => n.num));

  // scoring
  const scored = numeric.map(e => {
    let score = 0;
    // source priority
    if (String(e.source).includes("jsonld")) score += 40;
    if (String(e.source).includes("selector")) score += 25;
    if (String(e.source).includes("xhr")) score += 10;
    if (String(e.source).includes("body")) score += 2;

    // computedTotal high boost
    if (e.computedTotal) score += 50;

    // parcel raw penalize
    if (e.isParcel) score -= 20;

    // occurrences
    const f = freq[Number(e.num).toFixed(2)] || 0;
    score += Math.min(f, 5) * 6;

    // proximity boost
    const prox = proximityMap[e.raw] || proximityMap[String(e.raw)] || null;
    if (prox) {
      if (prox.near) score += 20;
      score += Math.min(prox.count||0,5) * 2;
    }

    // prefer bigger numbers generally (price totals)
    // but avoid absurdly large ones: if number >> median*50 penalize
    if (median && median > 0) {
      const ratio = e.num / median;
      if (ratio >= 0.2 && ratio <= 10) score += 3;
      if (ratio < 0.02) score -= 10;
      if (ratio > 50) score -= 30;
    }

    // penalize tiny numbers < 1 real (unless all candidates < 5)
    if (e.num < 1) score -= 25;

    // small-value safety: if all nums < 5 allow them by not penalizing further (handled below)
    return { ...e, score };
  });

  // if all numeric candidates are small (<5), remove small penalty for <1
  const allSmall = uniqueNums.every(n => n < 5);
  if (allSmall) {
    for (const s of scored) {
      if (s.num < 1) s.score += 30;
    }
  }

  scored.sort((a,b) => {
    if (b.score !== a.score) return b.score - a.score;
    // tie-breaker: prefer closer to maxValue (prefer totals)
    const da = Math.abs(b.num - maxValue), db = Math.abs(a.num - maxValue);
    return da - db;
  });

  // debug output
  try {
    console.log("PRICE CANDIDATES (num,score,raw,source):", scored.map(s => ({ num: s.num, score: s.score, raw: s.raw, source: s.source })));
  } catch (e) {}

  const best = scored[0];
  if (!best) return null;
  return `R$ ${Number(best.num).toFixed(2).replace(".", ",")}`;
}


// ---------------- main scraper ----------------
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
        console.warn("networkidle2 falhou, tentando domcontentloaded:", err && (err.message || err));
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
        const blocks = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
        for (const block of blocks) {
          let parsed = null;
          try { parsed = JSON.parse(block); } catch (e) { parsed = null; }
          if (!parsed) continue;
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list.flat()) {
            if (!item) continue;
            if (!title && (item.name || item.title)) title = item.name || item.title;
            if (!image && item.image) {
              const img = Array.isArray(item.image) ? item.image[0] : item.image;
              image = typeof img === "object" ? img.url || img.contentUrl : img;
            }
            if (item.offers) {
              const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
              for (const o of offers) {
                if (o.price) rawCandidates.push({ raw: String(o.price), source: "jsonld" });
                // sometimes priceSpecification contains subfields
                if (o.priceSpecification && typeof o.priceSpecification === "object") {
                  const spec = o.priceSpecification.price || o.priceSpecification.priceComponent || o.priceSpecification.minPrice || o.priceSpecification.maxPrice;
                  if (spec) rawCandidates.push({ raw: String(spec), source: "jsonld" });
                }
              }
            }
          }
        }
      } catch (e) { /* ignore */ }

      // og fallback
      const ogTitle = await page.$eval("meta[property='og:title']", e => e.content).catch(() => null);
      if (ogTitle && !title) title = ogTitle;
      const ogImage = await page.$eval("meta[property='og:image']", e => e.content).catch(() => null);
      if (ogImage && !image) image = ogImage;

      // visible selectors
      const selList = ["[itemprop='price']", ".price", ".product-price", ".sales-price", ".valor", ".priceFinal", ".productPrice", ".price--main", ".product-price-amount"];
      for (const sel of selList) {
        const vals = await page.$$eval(sel, els => els.map(e => (e.getAttribute('content') || e.innerText || e.textContent || '').trim()).filter(Boolean)).catch(() => []);
        for (const v of vals) rawCandidates.push({ raw: v, source: "selector" });

        const shadow = await querySelectorShadow(page, sel);
        if (shadow && shadow.text) rawCandidates.push({ raw: shadow.text, source: "selector" });
      }

      // xhr
      const xhrList = collectXHR();
      for (const o of xhrList) {
        if (!o) continue;
        if (typeof o === "string") rawCandidates.push({ raw: o, source: "xhr" });
        else rawCandidates.push(o);
      }

      // body fallback
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (body) {
        const matches = Array.from(new Set((body.match(/(?:R\$|\b)\s?[\d\.,]{2,}/g) || []).map(s => s.trim())));
        for (const m of matches) rawCandidates.push({ raw: m, source: "body" });
      }

      // dedupe preserving source variety
      const seen = new Set();
      const dedup = [];
      for (const c of rawCandidates) {
        if (!c || !c.raw) continue;
        const key = `${String(c.raw).trim()}|${c.source||""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(c);
      }

      // proximity map
      const uniqueRaw = Array.from(new Set(dedup.map(c => String(c.raw))));
      const proximityInfo = await page.evaluate((cands, titleText, imageUrl) => {
        const info = {};
        cands.forEach(c => info[c] = { near: false, count: 0 });
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

      // finalize
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
      await browser.close().catch(()=>{});
      return { success: false, error: String(err) };
    }
  });
}

// ---------------- routes ----------------
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

