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

// ---------------- collect XHR but tag source ----------------
function createXHRPriceCollector(page) {
  const prices = []; // will store objects { raw, source }
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
            if (k.toLowerCase().includes("price") || k.toLowerCase().includes("amount") || k.toLowerCase().includes("value")) {
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

// ---------------- robust normalization ----------------
function normalizePrice(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // keep original for checks
  const original = s;

  // remove NBSP and currency markers
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/(r\$\s?)/i, "");
  s = s.replace(/(brl)/i, "");
  s = s.replace(/[^\d.,]/g, ""); // keep digits, commas, dots

  if (!s) return null;

  // If pure digits (like "590400" or "7904"), decide heuristics:
  if (/^\d+$/.test(s)) {
    const asInt = Number(s);
    if (asInt > 100000) {
      // likely cents -> divide by 100
      return asInt / 100;
    }
    // ambiguous: if between 1000 and 99999 could be reais without separators
    // but we keep as-is (e.g., 7904 => 7904.00) and allow scoring to decide
    return asInt;
  }

  // If both dot and comma exist, the last separator is most likely decimal.
  if (s.indexOf(".") !== -1 && s.indexOf(",") !== -1) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // comma decimal, dot thousands
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // dot decimal, comma thousands -> remove commas
      s = s.replace(/,/g, "");
    }
  } else if (s.indexOf(",") !== -1 && s.indexOf(".") === -1) {
    // only comma present: if decimals length <=2 after comma => decimal
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // ambiguous e.g. "1,000" -> treat as thousands separator
      s = s.replace(/,/g, "");
    }
  } else if (s.indexOf(".") !== -1 && s.indexOf(",") === -1) {
    // only dot present: if last part two digits likely decimal else thousands
    const parts = s.split(".");
    if (parts.length === 2 && parts[1].length === 2) {
      // decimal
      // keep dot as decimal
    } else {
      // remove dots as thousands separators
      s = s.replace(/\./g, "");
    }
  }

  // final replace comma with dot (if any)
  s = s.replace(",", ".");
  const num = Number(s);
  if (isNaN(num)) return null;

  // heuristic: if original looked like integer large and num > 100000 then maybe cents -> divide by 100
  if (num > 100000 && Number.isInteger(num)) {
    const possible = num / 100;
    return possible;
  }

  return num;
}

// ---------------- scoring + finalize with source weighting ----------------
function finalizePrice(candidatesArray, proximityMap = {}) {
  // candidatesArray: array of objects { raw, source } OR strings
  if (!Array.isArray(candidatesArray) || candidatesArray.length === 0) return null;

  // normalize input into objects with source
  const rawObjs = candidatesArray.map((c) => {
    if (!c) return null;
    if (typeof c === "string") return { raw: c, source: "unknown" };
    // if object maybe already {raw, source}
    const raw = c.raw != null ? String(c.raw) : "";
    const source = c.source || "unknown";
    return { raw, source };
  }).filter(Boolean);

  // collapse identical raw strings but keep sources aggregated
  const map = new Map(); // raw -> { raw, sources: Set, count }
  for (const o of rawObjs) {
    const r = o.raw.trim();
    if (!map.has(r)) map.set(r, { raw: r, sources: new Set(), count: 0 });
    const entry = map.get(r);
    entry.sources.add(o.source || "unknown");
    entry.count += 1;
  }

  const entries = Array.from(map.values()).map((e) => {
    e.num = normalizePrice(e.raw);
    return e;
  }).filter(e => e.num !== null && Number.isFinite(e.num));

  if (entries.length === 0) return null;

  // build frequency by numeric string
  const freqNum = {};
  for (const e of entries) {
    const key = e.num.toFixed(2);
    freqNum[key] = (freqNum[key] || 0) + e.count;
  }

  // compute median scale to identify suspicious outliers
  const nums = [...new Set(entries.map(e => e.num))].sort((a,b)=>a-b);
  let median = null;
  if (nums.length > 0) {
    const mid = Math.floor(nums.length / 2);
    median = nums.length % 2 === 1 ? nums[mid] : (nums[mid-1] + nums[mid]) / 2;
  }

  // scoring function
  const scoreEntry = (e) => {
    let score = 0;
    const raw = e.raw.toLowerCase();

    // SOURCE weight: strong preference to jsonld/meta/selector > xhr > body/unknown
    if (e.sources.has("jsonld")) score += 30;
    if (e.sources.has("meta")) score += 20;
    if (e.sources.has("selector")) score += 18;
    if (e.sources.has("selector-visible")) score += 22; // visible selector near title/image
    if (e.sources.has("xhr")) score += 10;
    if (e.sources.has("body")) score += 2;
    if (e.sources.has("unknown")) score += 0;

    // explicit currency mention in raw
    if (/\br\$/.test(raw) || /\bbrl\b/.test(raw)) score += 6;

    // good formatting: thousands + cents
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(e.raw)) score += 8;

    // centavos presence
    if (/[,\.]\d{2}$/.test(e.raw)) score += 4;

    // penalize installments
    if (/parcela|parcelas|installment|juros/.test(raw)) score -= 8;

    // penalize long digit-only strings (IDs)
    const digitsOnly = e.raw.replace(/[^\d]/g, "");
    if (/^\d{6,}$/.test(digitsOnly) && !/[.,]/.test(e.raw)) score -= 10;

    // frequency boost (appearances)
    const f = freqNum[e.num.toFixed(2)] || 0;
    score += Math.min(f, 6) * 3;

    // proximity boost from proximityMap if present (map keys are raw strings)
    const prox = proximityMap[e.raw];
    if (prox) {
      if (prox.near) score += 18;
      score += Math.min(prox.count || 0, 5) * 2;
    }

    // coherence with median
    if (median && median > 0) {
      const ratio = e.num / median;
      if (ratio >= 0.2 && ratio <= 5) score += 2;
      if (ratio < 0.03) score -= 6; // far too small
      if (ratio > 20) score -= 6; // far too large
    }

    // small numbers penalty but not absolute
    if (e.num < 1) score -= 6;

    return score;
  };

  const scored = entries.map(e => ({ ...e, score: scoreEntry(e) }));

  // sort by score desc, tiebreaker by frequency then numeric closeness to median
  scored.sort((a,b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = freqNum[a.num.toFixed(2)] || 0;
    const fb = freqNum[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    // prefer value closer to median
    if (median !== null) {
      return Math.abs(a.num - median) - Math.abs(b.num - median);
    }
    return a.num - b.num;
  });

  // debug logging for you
  console.log("RAW_CANDIDATES:", entries.map(e => ({ raw: e.raw, num: e.num, sources: Array.from(e.sources), count: e.count })));
  console.log("SCORED_CANDIDATES:", scored.map(s => ({ raw: s.raw, num: s.num, score: s.score, sources: Array.from(s.sources) })));

  const best = scored[0];
  if (!best) return null;
  return `R$ ${best.num.toFixed(2).replace(".", ",")}`;
}

// ---------------- main scraper ----------------

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

      // NAVIGATION
      try {
        await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
      } catch {
        await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
      }

      await page.waitForTimeout(700);
      await autoScroll(page);
      await page.waitForTimeout(600);

      let title = null;
      let image = null;
      const rawCandidates = []; // will contain objects { raw, source }

      // 1) JSON-LD (source = jsonld)
      try {
        const blocks = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of arr.flat()) {
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
                }
              }
            }
          } catch (e) { /* ignore parse errors */ }
        }
      } catch (e) {}

      // 2) OpenGraph meta (source = meta)
      if (!title) {
        const ogTitle = await page.$eval('meta[property="og:title"]', e => e.content).catch(() => null);
        if (ogTitle) title = ogTitle;
      }
      const ogImage = await page.$eval('meta[property="og:image"]', e => e.content).catch(() => null);
      if (ogImage) {
        if (!image) image = ogImage;
      }

      // 3) selectors visible (source = selector or selector-visible)
      // collect price-like selectors and tag as 'selector' (later we'll mark 'selector-visible' if near title/image)
      const selectorList = [
        { sel: "[itemprop='price']", name: "itemprop_price" },
        { sel: ".price", name: "class_price" },
        { sel: ".product-price", name: "product-price" },
        { sel: ".sales-price", name: "sales-price" },
        { sel: ".best-price", name: "best-price" },
        { sel: ".valor", name: "valor" },
        { sel: ".priceFinal", name: "priceFinal" },
        { sel: ".productPrice", name: "productPrice" },
        { sel: ".price--main", name: "price--main" },
        { sel: ".product-price-amount", name: "product-price-amount" },
        { sel: "meta[property='product:price:amount']", name: "meta_price_amount" }
      ];

      for (const it of selectorList) {
        const values = await page.$$eval(it.sel, els => els.map(el => {
          try {
            if (el.tagName === "META") return el.getAttribute("content") || null;
            return (el.innerText || el.textContent || el.getAttribute("content") || "").trim();
          } catch (e) { return null; }
        }).filter(Boolean)).catch(()=>[]);
        for (const v of values) rawCandidates.push({ raw: String(v), source: "selector" });
      }

      // 4) search common image selectors
      if (!image) {
        const imgCandidates = [
          "img#product-image",
          ".product-image img",
          ".pdp-image img",
          ".gallery img",
          ".image img"
        ];
        for (const sel of imgCandidates) {
          const src = await page.$eval(sel, el => el.currentSrc || el.src).catch(()=>null);
          if (src) { image = src; break; }
        }
      }

      // 5) XHR collected: already objects {raw, source: 'xhr'}
      const xhr = collectXHR();
      for (const o of xhr) rawCandidates.push(o);

      // 6) Fallback: scan body text for R$ patterns (tag as 'body')
      const bodyText = await page.evaluate(() => document.body.innerText).catch(()=>"");
      if (bodyText) {
        const matches = Array.from(new Set((bodyText.match(/R\$\s?[\d\.,]+/g) || []).map(s => s.trim())));
        for (const m of matches) rawCandidates.push({ raw: m, source: "body" });
      }

      // 7) If still no title, fallback to visible selectors
      if (!title) {
        title = await page.evaluate(() => {
          const sels = ["h1", ".product-title", ".product-name", ".pdp-title"];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return (el.innerText || el.textContent).trim();
          }
          return null;
        }).catch(()=>null);
      }

      // make unique by raw string but keep sources aggregated
      const aggregated = new Map(); // raw -> { raw, sources:Set, count }
      for (const c of rawCandidates) {
        if (!c || !c.raw) continue;
        const r = String(c.raw).trim();
        if (!r) continue;
        if (!aggregated.has(r)) aggregated.set(r, { raw: r, sources: new Set(), count: 0 });
        const e = aggregated.get(r);
        e.sources.add(c.source || "unknown");
        e.count += 1;
      }

      // prepare array for proximity check keys
      const uniqueRawList = Array.from(aggregated.keys());

      // 8) proximity analysis to detect visible prices near title/image
      // returns map { "<raw>": { near: bool, count: n } }
      const proximityInfo = await page.evaluate((candidates, titleText, imageUrl) => {
        const info = {};
        candidates.forEach(c => { info[c] = { near: false, count: 0 }; });

        const titleEls = [];
        if (titleText && titleText.trim().length>0) {
          const poss = Array.from(document.querySelectorAll("h1, .product-title, .product-name, .pdp-title"));
          for (const el of poss) {
            try { if ((el.innerText||el.textContent||"").trim().includes(titleText.trim())) titleEls.push(el); } catch(e) {}
          }
        }
        const imageEls = [];
        if (imageUrl && imageUrl.trim().length>0) {
          const imgs = Array.from(document.querySelectorAll("img"));
          for (const im of imgs) {
            try { const src = im.currentSrc || im.src || ""; if (src && src.includes(imageUrl)) imageEls.push(im); } catch(e) {}
          }
        }
        const contextEls = [...titleEls, ...imageEls];

        function nearEachOther(node, ctxs, maxDepth=6) {
          if (!node || !ctxs || ctxs.length===0) return false;
          for (const ctx of ctxs) {
            if (ctx.contains(node) || node.contains(ctx)) return true;
            let a = node;
            for (let i=0;i<maxDepth && a;i++) { if (a===ctx) return true; a = a.parentElement; }
            a = ctx;
            for (let i=0;i<maxDepth && a;i++) { if (a===node) return true; a = a.parentElement; }
          }
          return false;
        }

        for (const cand of candidates) {
          if (!cand || cand.trim().length===0) continue;
          // find nodes containing this candidate text
          const nodes = Array.from(document.querySelectorAll("body *")).filter(n => {
            try {
              const t = (n.innerText || n.textContent || "");
              return t && t.includes(cand);
            } catch(e) { return false; }
          });
          info[cand].count = nodes.length;
          if (contextEls.length===0) continue;
          for (const n of nodes) {
            if (nearEachOther(n, contextEls, 6)) { info[cand].near = true; break; }
          }
        }
        return info;
      }, uniqueRawList, title || "", image || "");

      // aggregate proximity into our aggregated map and mark source 'selector-visible' if near
      for (const [raw, obj] of aggregated.entries()) {
        const prox = proximityInfo[raw];
        if (prox) {
          if (prox.near) obj.sources.add("selector-visible");
          obj.prox = prox;
        }
      }

      // convert aggregated into array for finalizePrice
      const finalCandidates = [];
      for (const [raw, obj] of aggregated.entries()) {
        // push object with raw and combined sources (array) and count: used by finalizePrice
        finalCandidates.push({ raw, source: Array.from(obj.sources).join("|"), count: obj.count });
      }

      // Also include raw xhr entries that might not be in aggregated (rare)
      // (collectXHR earlier already pushed into rawCandidates so aggregated covered them)

      // FINALIZE
      const finalPrice = finalizePrice(finalCandidates.map(fc => {
        // convert back to object style expected: { raw, source } with source as each individual source tag
        // split the joined source string to multiple sources
        const sources = (fc.source || "").split("|").filter(Boolean);
        // if no sources fallback to unknown
        if (sources.length === 0) return { raw: fc.raw, source: "unknown" };
        // push one entry per source to let finalizePrice aggregate
        // but finalizePrice already aggregates by raw; here we'll just return the object with joined source as string - finalizePrice understands Set
        return { raw: fc.raw, source: sources[0] || "unknown" };
      }), (() => {
        // build proximityMap keyed by raw original strings
        const proxMap = {};
        for (const [raw, obj] of aggregated.entries()) {
          proxMap[raw] = { near: !!(obj.prox && obj.prox.near), count: (obj.prox && obj.prox.count) || obj.count || 0 };
        }
        return proxMap;
      })());

      if (title && typeof title === "string") title = title.split("|")[0].split("-")[0].trim();

      await browser.close();

      return {
        success: true,
        url: cleaned,
        title: title || null,
        price: finalPrice || null,
        image: image || null,
        rawCandidatesCount: finalCandidates.length
      };
    } catch (err) {
      await browser.close().catch(()=>{});
      console.error("SCRAPE ERROR:", err && err.message ? err.message : err);
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
    console.error("ROUTE ERROR:", e && e.message ? e.message : e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

