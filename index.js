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

/* ---------------- helpers ---------------- */

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

/* ---------------- XHR collector (improved) ----------------
   - captura preços em JSON e marca parcelas / campos
*/
function createXHRPriceCollector(page) {
  const prices = [];
  page.on("response", async (resp) => {
    try {
      const url = resp.url().toLowerCase();
      // heurística de endpoints
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
            if (v === null || v === undefined) continue;

            // strings / numbers as candidates
            if (typeof v === "string" || typeof v === "number") {
              const text = String(v).trim();
              // detect parcel pattern inside json value
              const parcelMatch = text.match(/(\d+)\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || text.match(/(\d+)\s*[xX]\s*(?:de\s*)?([\d\.,]+)/i);
              if (parcelMatch) {
                prices.push({ raw: text, source: "xhr", isInstallment: true, parcelCount: Number(parcelMatch[1]), parcelValueRaw: parcelMatch[2], url });
                // also push a marker for computed total (we'll compute later)
                prices.push({ raw: `computed_installment_total:${parcelMatch[1]}x${parcelMatch[2]}`, source: "xhr", computedFrom: { count: Number(parcelMatch[1]), rawValue: parcelMatch[2] }, url });
              } else {
                prices.push({ raw: text, source: "xhr", url });
              }
            }

            // common price-like object: price, amount, value
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

/* ---------------- parse helpers ----------------
   convert string -> number (BR/EN heuristics),
   detect installments,
   handle numeric-only centavos heuristics
*/
function parseNumberFromString(raw) {
  if (raw === null || raw === undefined) return { num: null, note: "empty" };
  let s = String(raw).trim();
  if (!s) return { num: null, note: "empty" };

  // remove NBSPs
  s = s.replace(/\u00A0/g, "");

  // remove currency letters but keep separators
  s = s.replace(/R\$|BRL|\$/gi, "");

  // if contains 'x' and digits, leave for installment detection upstream
  // now remove non-digit/sep
  const cleaned = s.replace(/[^0-9\.,]/g, "");
  if (!cleaned) return { num: null, note: "no digits" };

  let t = cleaned;

  // If both '.' and ',' present, assume Brazilian style 1.234,56
  if (t.includes(".") && t.includes(",")) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",") && !t.includes(".")) {
    // ambiguous: treat comma as decimal if right side length <=2
    const parts = t.split(",");
    if (parts[1] && parts[1].length <= 2) {
      t = t.replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
  } else if (t.includes(".") && !t.includes(",")) {
    // if dot used, but the right side length != 2, treat dots as thousands
    const parts = t.split(".");
    if (!(parts[1] && parts[1].length === 2)) {
      t = t.replace(/\./g, "");
    }
  }

  // remove any leftover non-digit/dot
  t = t.replace(/[^0-9.]/g, "");
  if (!t) return { num: null, note: "cleaned empty" };

  let n = Number(t);
  if (!Number.isFinite(n)) return { num: null, note: "not finite" };

  // Heuristic: if extremely big integer without decimal separators, maybe centavos: e.g., "731200" likely 7312.00
  const digitsOnly = t.replace(".", "");
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length >= 6 && n > 100000) {
    // interpret as cents
    return { num: n / 100, note: "cent heuristic" };
  }

  return { num: n, note: "parsed" };
}

function detectInstallmentFromString(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || s.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?([\d\.,]+)/i);
  if (!m) return null;
  const count = Number(m[1]);
  const valueRaw = m[2];
  const parsed = parseNumberFromString(valueRaw);
  if (parsed.num && count > 0) return { count, parcelValue: parsed.num, total: parsed.num * count };
  return null;
}

/* ---------------- final price decision (strong heuristics) ----------------
   - receives candidates: array of objects { raw, source, ... }
   - builds numeric entries, includes computed totals from installments
   - scores candidates and returns formatted "R$ X,XX"
*/
function finalizePrice(candidates, proximityMap = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // Build numeric entries
  const entries = [];
  for (const c of candidates) {
    if (!c || !c.raw) continue;
    const raw = String(c.raw).trim();

    // if marker for computed installment from xhr structure
    if (c.computedFrom && c.computedFrom.rawValue && c.computedFrom.count) {
      const p = parseNumberFromString(c.computedFrom.rawValue);
      if (p.num) {
        const total = p.num * Number(c.computedFrom.count);
        entries.push({ raw, num: total, source: c.source || "xhr", computedTotal: true, info: "computedFromXHR" });
        continue;
      }
    }

    // if raw indicates computed_installment_total:<count>x<value>
    const compMatch = raw.match(/^computed_installment_total:(\d+)x(.+)$/i);
    if (compMatch) {
      const cnt = Number(compMatch[1]);
      const valRaw = compMatch[2];
      const p = parseNumberFromString(valRaw);
      if (p.num) entries.push({ raw, num: p.num * cnt, source: c.source || "xhr", computedTotal: true, info: "computedFromMarker" });
      continue;
    }

    // explicit object produced in collector: isInstallment
    if (c.isInstallment && c.parcelCount && c.parcelValueRaw) {
      const p = parseNumberFromString(c.parcelValueRaw);
      if (p.num) {
        entries.push({ raw, num: p.num * Number(c.parcelCount), source: c.source || "xhr", computedTotal: true, info: "xhr-installment" });
        // also keep per-installment (lower priority)
        entries.push({ raw: `${raw}_per_installment`, num: p.num, source: c.source || "xhr", isParcel: true, parcelCount: c.parcelCount });
        continue;
      }
    }

    // detect installment inside raw
    const inst = detectInstallmentFromString(raw);
    if (inst && inst.total) {
      entries.push({ raw, num: inst.total, source: c.source || "mixed", computedTotal: true, info: "detected-installment" });
      entries.push({ raw: `${raw}_per_installment`, num: inst.parcelValue, source: c.source || "mixed", isParcel: true, parcelCount: inst.count });
      continue;
    }

    // normal parse
    const p = parseNumberFromString(raw);
    if (p.num) entries.push({ raw, num: p.num, source: c.source || "unknown", note: p.note });
  }

  const numeric = entries.filter(e => typeof e.num === "number" && Number.isFinite(e.num) && e.num > 0);
  if (numeric.length === 0) {
    console.log("No numeric price candidates found from:", candidates);
    return null;
  }

  // Build frequency and median for coherence
  const freq = {};
  numeric.forEach(e => { const k = Number(e.num).toFixed(2); freq[k] = (freq[k] || 0) + 1; });
  const uniqueNums = Array.from(new Set(numeric.map(e => e.num))).sort((a,b)=>a-b);
  const median = uniqueNums.length ? uniqueNums[Math.floor(uniqueNums.length/2)] : null;
  const maxVal = Math.max(...numeric.map(n => n.num));

  // Score candidates
  const scored = numeric.map(e => {
    let score = 0;
    const src = String(e.source || "");
    if (src.includes("jsonld")) score += 50;
    if (src.includes("selector")) score += 30;
    if (src.includes("xhr")) score += 12;
    if (src.includes("body")) score += 3;

    if (e.computedTotal) score += 60; // very strong -> totals computed from installments or structured data

    if (e.isParcel) score -= 30; // per-installment is penalized

    // presence of currency symbol in raw gives boost
    if (/R\$/.test(e.raw)) score += 8;

    // frequency
    const f = freq[Number(e.num).toFixed(2)] || 0;
    score += Math.min(f, 5) * 6;

    // proximity to title/image
    const prox = proximityMap[e.raw] || proximityMap[String(e.raw)] || null;
    if (prox) {
      if (prox.near) score += 22;
      score += Math.min(prox.count || 0, 5) * 2;
    }

    // coherence with median: penalize absurd outliers
    if (median && median > 0) {
      const ratio = e.num / median;
      if (ratio >= 0.25 && ratio <= 10) score += 4;
      if (ratio < 0.03) score -= 15;
      if (ratio > 50) score -= 30;
    }

    // penalize tiny numbers < 1
    if (e.num < 1) score -= 20;

    return { ...e, score };
  });

  // if all candidates are small (<5), remove penalty for <1
  const allSmall = uniqueNums.every(n => n < 5);
  if (allSmall) {
    for (const s of scored) {
      if (s.num < 1) s.score += 30;
    }
  }

  scored.sort((a,b) => b.score - a.score);
  console.log("PRICE CANDIDATES (num,score,raw,source,info):", scored.map(s => ({ num: s.num, score: s.score, raw: s.raw, source: s.source, info: s.info })));

  const best = scored[0];
  if (!best) return null;
  return `R$ ${Number(best.num).toFixed(2).replace(".", ",")}`;
}

/* ---------------- main scraper ---------------- */

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
        "--window-size=1920,1080"
      ],
      defaultViewport: { width: 1920, height: 1080 }
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
                // some offer specs contain nested price fields
                if (o.priceSpecification) {
                  const ps = o.priceSpecification;
                  if (ps.price) rawCandidates.push({ raw: String(ps.price), source: "jsonld" });
                  if (ps.priceCurrency && ps.price) rawCandidates.push({ raw: `${ps.price}`, source: "jsonld" });
                }
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }

      // OG fallback
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

      // XHR
      const xhrList = collectXHR();
      for (const o of xhrList) {
        if (!o) continue;
        // if already object (our collector pushes objects), keep
        if (typeof o === "object" && o.raw) rawCandidates.push(o);
        else rawCandidates.push({ raw: String(o), source: "xhr" });
      }

      // Body fallback
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (body) {
        // broader regex: includes numbers with thousands separators
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

      console.log("RAW CANDIDATES COLLECTED:", dedup.slice(0,200));

      // proximity map: whether candidate appears near title or image
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

      // finalize price with robust function
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
      console.error("SCRAPER ERROR:", err && (err.message || err));
      return { success: false, error: String(err) };
    }
  });
}

/* ---------------- routes ---------------- */

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    console.error("ROUTE ERROR:", e && e.message);
    res.status(500).json({ success: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

