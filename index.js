// index.js - scraper completo com nova lógica de preço (prioriza JSON-LD, XHR e proximidade ao CTA)
// Versão ajustada: detecta parcelas explícitas e emparelha número de parcelas + valor para criar total computado,
// boosta totals computados para evitar retornar valor por parcela ou valores próximos incorretos.

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();

// <-- CORREÇÃO ADICIONADA: evita ValidationError do express-rate-limit com X-Forwarded-For
app.set("trust proxy", 1);

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
  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map(m => m[0]);
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
      }, 120);
    });
  }, maxScroll);
}

async function querySelectorShadowReturn(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      try {
        if (root.querySelector) {
          const found = root.querySelector(sel);
          if (found) return found;
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const n of nodes) {
          try {
            if (n.shadowRoot) {
              const r = search(n.shadowRoot);
              if (r) return r;
            }
          } catch (e) {}
        }
      } catch (e) {}
      return null;
    }
    const el = search(document);
    if (!el) return null;
    if (el.tagName === 'IMG') return { type: 'img', src: el.currentSrc || el.src || null };
    if (el.tagName === 'META') return { type: 'meta', content: el.content || null };
    return { type: 'other', text: (el.innerText || el.textContent || '').trim() || null };
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
        url.includes("offers") ||
        url.includes("sku") ||
        url.includes("product") ||
        url.includes("pricing") ||
        url.includes("/item") ||
        url.includes("/products")
      ) {
        const ctype = (resp.headers && resp.headers()["content-type"]) || "";
        if (!ctype.includes("application/json")) return;
        const json = await resp.json().catch(() => null);
        if (!json) return;
        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k of Object.keys(o)) {
            const v = o[k];
            const lkey = String(k).toLowerCase();
            if (v === null || v === undefined) continue;
            if (typeof v === "string" || typeof v === "number") {
              const text = String(v).trim();
              const inst = text.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || text.match(/(\d{1,3})x([\d\.,]+)/i);
              if (inst) {
                prices.push({ raw: text, source: "xhr", isInstallment: true, parcelCount: Number(inst[1]), parcelValueRaw: inst[2], url });
                prices.push({ raw: `computed_installment_total:${inst[1]}x${inst[2]}`, source: "xhr", computedFrom: { count: Number(inst[1]), rawValue: inst[2] }, url });
              } else if (lkey.includes("price") || lkey.includes("amount") || lkey.includes("value") || lkey.includes("priceamount") || lkey.includes("sale")) {
                prices.push({ raw: text, source: "xhr", field: k, url });
              }
            }
            if (typeof v === "object") walk(v);
          }
        };
        walk(json);
      }
    } catch (e) {
      // ignore
    }
  });
  return () => prices;
}

// ---------------- parsing helpers ----------------
function parseNumberFromString(raw) {
  if (raw === null || raw === undefined) return { num: null, note: "empty" };
  let s = String(raw).trim();
  if (!s) return { num: null, note: "empty" };

  s = s.replace(/\u00A0/g, ""); // NBSP
  s = s.replace(/(R\$|BRL|\$)/gi, "");

  // remove non numeric except . and ,
  const cleaned = s.replace(/[^0-9\.,]/g, "");
  if (!cleaned) return { num: null, note: "no digits" };
  let t = cleaned;

  if (t.includes(".") && t.includes(",")) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",") && !t.includes(".")) {
    const parts = t.split(",");
    if (parts[1] && parts[1].length <= 2) {
      t = t.replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
  } else if (t.includes(".") && !t.includes(",")) {
    const parts = t.split(".");
    if (!(parts[1] && parts[1].length === 2)) {
      t = t.replace(/\./g, "");
    }
  }

  t = t.replace(/[^0-9.]/g, "");
  if (!t) return { num: null, note: "cleaned empty" };

  let n = Number(t);
  if (!Number.isFinite(n)) return { num: null, note: "not finite" };

  // heuristic: long integer without separators likely centavos -> apply conservatively
  const digitsOnly = t.replace(".", "");
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length >= 7 && n > 10000) {
    return { num: n / 100, note: "cent heuristic" };
  }

  return { num: n, note: "parsed" };
}

function detectInstallmentFromString(raw) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || s.match(/(\d{1,3})x([\d\.,]+)/i) || s.match(/(\d{1,3})\s*vezes?\s*de\s*R?\$?\s*([\d\.,]+)/i);
  if (!m) return null;
  const count = Number(m[1]);
  const valueRaw = m[2];
  const parsed = parseNumberFromString(valueRaw);
  if (parsed.num && count > 0) return { count, parcelValue: parsed.num, total: parsed.num * count };
  return null;
}

// ---------------- NEW: busca preço próximo ao CTA (botão comprar) ----------------
async function findPricesNearCTA(page) {
  return page.evaluate(() => {
    const ctaSelectors = [
      "button.add-to-cart", "button#adicionar", "button[aria-label*='carrinho']",
      "button[aria-label*='comprar']", "button[title*='Comprar']", "button[type='submit']",
      ".buy-button", ".buyNow", ".add-to-cart-button", ".productActionAdd", ".add-to-cart",
      "a.add-to-cart", "a[href*='add-to-cart']"
    ];
    const priceCandidates = new Set();
    const priceRegex = /(?:\d{1,3}\s*[xX]\s*R\$\s*[\d\.,]+|R\$\s?[\d\.,]+)/g;

    function collectNearbyTexts(el) {
      const texts = [];
      try {
        if (!el) return texts;
        if (el.innerText) texts.push(el.innerText);
        if (el.parentElement) {
          for (const sib of Array.from(el.parentElement.children)) {
            if (sib && sib !== el && sib.innerText) texts.push(sib.innerText);
          }
        }
        let node = el.parentElement;
        for (let i = 0; i < 4 && node; i++) {
          if (node.innerText) texts.push(node.innerText);
          node = node.parentElement;
        }
        for (const d of Array.from(el.querySelectorAll ? el.querySelectorAll("*") : [])) {
          if (d.innerText) texts.push(d.innerText);
        }
      } catch (e) {}
      return texts;
    }

    for (const sel of ctaSelectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const n of nodes) {
          const texts = collectNearbyTexts(n);
          for (const t of texts) {
            const matches = t.match(priceRegex);
            if (matches) matches.forEach(m => priceCandidates.add(m.trim()));
          }
        }
      } catch (e) {}
    }

    const textCTAs = Array.from(document.querySelectorAll("button, a")).filter(n => {
      const txt = (n.innerText || "").toLowerCase();
      return txt.includes("comprar") || txt.includes("adicionar") || txt.includes("cart") || txt.includes("carrinho") || txt.includes("buy") || txt.includes("add to cart");
    });
    for (const n of textCTAs) {
      const texts = collectNearbyTexts(n);
      for (const t of texts) {
        const matches = t.match(priceRegex);
        if (matches) matches.forEach(m => priceCandidates.add(m.trim()));
      }
    }

    return Array.from(priceCandidates);
  });
}

// ---------------- FINAL PRICE SELECTION (nova estratégia, mais conservadora) ----------------
function selectBestPrice(candidatesWithMeta, proximityMap = {}) {
  if (!Array.isArray(candidatesWithMeta) || candidatesWithMeta.length === 0) return null;

  // Ensure candidatesWithMeta includes explicit installment patterns by scanning raws
  const augmented = [...candidatesWithMeta];

  // If there are separate numeric-only candidates (like '12') and per-installment candidates ('R$ 609,33'),
  // try to pair them to create computed totals.
  const rawStrings = augmented.map(c => String(c.raw || "").trim());
  // detect per-installment candidates (explicit)
  const perInstallmentCandidates = augmented.filter(c => detectInstallmentFromString(String(c.raw || "")));
  // detect standalone numbers that might be parcel counts
  const standaloneNumbers = augmented
    .map(c => ({ c, raw: String(c.raw || "").trim() }))
    .filter(x => /^\d{1,3}$/.test(x.raw))
    .map(x => Number(x.raw));

  // create computed candidates from explicit per-installment patterns already detected
  for (const p of augmented) {
    const inst = detectInstallmentFromString(String(p.raw || ""));
    if (inst && inst.total) {
      augmented.push({ raw: `computed_installment_total:${inst.count}x${inst.parcelValue}`, source: p.source || "detected", computedTotal: true });
    }
  }

  // pair standalone numbers with per-installment values when explicit 'Nx R$ V' not present
  if (standaloneNumbers.length && augmented.some(c => !/^\d+$/.test(String(c.raw || "")) && /R\$/i.test(String(c.raw || "")))) {
    for (const n of standaloneNumbers) {
      // find candidate values that look like price-per-installment (have R$ or decimal)
      const pricePerList = augmented.filter(c => /R\$/i.test(String(c.raw || "")) && !detectInstallmentFromString(String(c.raw || "")));
      for (const per of pricePerList) {
        const pParsed = parseNumberFromString(per.raw);
        if (pParsed.num) {
          const total = pParsed.num * n;
          augmented.push({ raw: `computed_pair_total:${n}x${per.raw}`, source: "paired", computedTotal: true, numComputed: total });
        }
      }
    }
  }

  // Now process augmented
  const processed = [];
  for (const c of augmented) {
    const raw = String(c.raw || "").trim();
    if (!raw) continue;

    // handle computed markers
    const comp = raw.match(/^computed_installment_total:(\d+)x(.+)$/i) || raw.match(/^computed_pair_total:(\d+)x(.+)$/i);
    if (comp) {
      const count = Number(comp[1]);
      const parsed = parseNumberFromString(comp[2]);
      if (parsed.num) {
        processed.push({ raw, source: c.source || "computed", num: parsed.num * count, computedTotal: true, isParcel: false });
        continue;
      }
      // if pattern is computed_pair_total:12xR$ 609,33 we might have 'numComputed' passed
      if (c.numComputed) {
        processed.push({ raw, source: c.source || "computed", num: c.numComputed, computedTotal: true, isParcel: false });
        continue;
      }
    }

    // detect inline installments
    const inst = detectInstallmentFromString(raw);
    if (inst && inst.total) {
      processed.push({ raw, source: c.source || "mixed", num: inst.total, computedTotal: true, isParcel: false, note: "detected-installment" });
      processed.push({ raw: raw + "_per", source: c.source || "mixed", num: inst.parcelValue, isParcel: true, parcelCount: inst.count });
      continue;
    }

    // try parse raw
    const p = parseNumberFromString(raw);
    if (p.num) {
      processed.push({ raw, source: c.source || "unknown", num: p.num, isParcel: false, note: p.note });
      continue;
    }

    // fallback numeric-only
    const digitsOnly = raw.replace(/\D/g, "");
    if (digitsOnly.length > 0 && /^\d+$/.test(digitsOnly)) {
      const asNum = Number(digitsOnly);
      if (!Number.isNaN(asNum) && asNum > 0) {
        if (digitsOnly.length <= 6) processed.push({ raw, source: c.source || "unknown", num: asNum, inferredInteger: true });
        else processed.push({ raw, source: c.source || "unknown", num: asNum, inferredInteger: true, likelyId: true });
      }
    }
  }

  if (processed.length === 0) return null;

  const freq = {};
  processed.forEach(p => {
    if (p.num == null) return;
    const k = Number(p.num).toFixed(2);
    freq[k] = (freq[k] || 0) + 1;
  });

  const uniqueNums = Array.from(new Set(processed.filter(p => Number.isFinite(p.num)).map(p => p.num))).sort((a,b)=>a-b);
  const median = uniqueNums.length ? uniqueNums[Math.floor(uniqueNums.length/2)] : null;
  const max = uniqueNums.length ? Math.max(...uniqueNums) : null;

  const scored = processed
    .filter(p => Number.isFinite(p.num))
    .map(p => {
      let score = 0;
      const src = String(p.source || "");

      if (src.includes("jsonld")) score += 70;
      else if (src.includes("selector")) score += 40;
      else if (src.includes("nearCTA")) score += 36;
      else if (src.includes("xhr")) score += 22;
      else if (src.includes("body")) score += 6;
      else score += 5;

      if (p.computedTotal) score += 70; // **MAJOR BOOST** para totais computados
      if (p.isParcel) score -= 45;

      if (/R\$/i.test(p.raw)) score += 12;

      const f = freq[Number(p.num).toFixed(2)] || 0;
      score += Math.min(f, 6) * 6;

      try {
        const prox = proximityMap[p.raw];
        if (prox) {
          if (prox.near) score += 28;
          score += Math.min(prox.count || 0, 6) * 3;
        }
      } catch (e) {}

      if (p.likelyId) score -= 90;
      if (p.num < 1) score -= 30;

      if (median && median > 0) {
        const ratio = p.num / median;
        if (ratio >= 0.2 && ratio <= 20) score += 4;
        if (ratio < 0.02) score -= 12;
        if (ratio > 50) score -= 18;
      }

      const hasExplicitCurrency = processed.some(pp => /R\$/i.test(pp.raw));
      if (hasExplicitCurrency && !/R\$/i.test(p.raw)) score -= 10;
      if (p.num > 1000000) score -= 100;
      if (max && max > 0) score += (p.num / max) * 2;

      return { ...p, score };
    });

  const allSmall = uniqueNums.every(n => n < 5);
  if (allSmall) {
    scored.forEach(s => { if (s.num < 1) s.score += 18; });
  }

  scored.sort((a,b) => b.score - a.score);

  console.log("PRICE CANDIDATES SCORED:", scored.map(s => ({ num: s.num, score: s.score, raw: s.raw, source: s.source, note: s.note || null })));

  const best = scored[0];
  if (!best) return null;

  // final safety: if best came from "cent heuristic" but explicit R$ candidate exists, prefer explicit
  if (best && /cent heuristic/i.test(best.note || "") && processed.some(p => /R\$/i.test(p.raw))) {
    const explicit = scored.find(s => /R\$/i.test(s.raw));
    if (explicit) {
      return `R$ ${Number(explicit.num).toFixed(2).replace(".", ",")}`;
    }
  }

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
      headless: process.env.PUPPETEER_HEADLESS === "false" ? false : "new",
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

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      try {
        const url = req.url().toLowerCase();
        const resourceType = req.resourceType ? req.resourceType() : "";
        if (resourceType === "font" || resourceType === "stylesheet") return req.abort();
        const blocked = ["googlesyndication", "google-analytics", "doubleclick", "adsystem", "adservice", "facebook", "hotjar", "segment", "matomo", "ads", "tracking"];
        if (blocked.some(d => url.includes(d))) return req.abort();
      } catch (e) {}
      return req.continue();
    });

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

      await page.waitForTimeout(600);
      await autoScroll(page, 1800);
      await page.waitForTimeout(700);

      let title = null;
      let image = null;
      const candidates = [];

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
                if (o.price) candidates.push({ raw: String(o.price), source: "jsonld" });
                if (o.price && o.priceCurrency) candidates.push({ raw: `${o.priceCurrency} ${o.price}`, source: "jsonld" });
                if (o.installments && o.installments.number && o.installments.price) {
                  candidates.push({ raw: `${o.installments.number} x ${o.installments.price}`, source: "jsonld" });
                }
              }
            }
          }
        }
      } catch (e) { /* ignore */ }

      // OpenGraph fallback
      const ogTitle = await page.$eval("meta[property='og:title']", e => e.content).catch(() => null);
      if (ogTitle && !title) title = ogTitle;
      const ogImage = await page.$eval("meta[property='og:image']", e => e.content).catch(() => null);
      if (ogImage && !image) image = ogImage;

      // visible selectors
      const selectorList = [
        '[itemprop="price"]',
        '[itemprop="priceSpecification"]',
        ".price",
        ".product-price",
        ".sales-price",
        ".best-price",
        ".valor",
        ".priceFinal",
        ".productPrice",
        ".price--main",
        ".product-price-amount",
        ".productPriceAmount",
        ".price__amount",
        ".priceValue"
      ];
      for (const sel of selectorList) {
        const vals = await page.$$eval(sel, els => els.map(e => (e.getAttribute('content') || e.getAttribute('data-price') || e.getAttribute('data-price-amount') || (e.innerText || e.textContent || '').trim())).filter(Boolean)).catch(() => []);
        for (const v of vals) candidates.push({ raw: v, source: "selector" });
        const shadow = await querySelectorShadowReturn(page, sel).catch(() => null);
        if (shadow && shadow.text) candidates.push({ raw: shadow.text, source: "selector" });
        if (shadow && shadow.src && !image) image = shadow.src;
      }

      // XHR
      const xhrList = collectXHR();
      for (const o of xhrList) {
        if (!o) continue;
        if (typeof o === "object" && o.raw) candidates.push(o);
        else candidates.push({ raw: String(o), source: "xhr" });
      }

      // near CTA
      const nearCTAPrices = await findPricesNearCTA(page).catch(() => []);
      for (const p of nearCTAPrices) candidates.push({ raw: p, source: "nearCTA" });

      // body fallback - agora captura parcelamentos explícitos também
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (body) {
        const matches = new Set();
        // capture installment forms like "12 x R$ 609,33" and "R$ 7.312"
        const instRegex = /(\d{1,3}\s*[xX]\s*(?:de\s*)?R?\$?\s*[\d\.,]+)/g;
        const currencyRegex = /R\$\s?[\d\.,]+/g;
        const plainNumberRegex = /\b\d{1,3}\b/g;

        const instFound = body.match(instRegex) || [];
        instFound.forEach(s => matches.add(s.trim()));

        const currFound = body.match(currencyRegex) || [];
        currFound.forEach(s => matches.add(s.trim()));

        // also add isolated small integers that might be parcel counts (12, 10, etc.) — careful but useful
        const maybeCounts = body.match(plainNumberRegex) || [];
        maybeCounts.forEach(s => {
          const n = Number(s);
          if (!isNaN(n) && n >= 2 && n <= 60) matches.add(String(s));
        });

        for (const m of Array.from(matches)) candidates.push({ raw: m, source: "body" });
      }

      // dedupe preserving first source
      const seen = new Set();
      const dedup = [];
      for (const c of candidates) {
        if (!c || !c.raw) continue;
        const key = String(c.raw).trim();
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(c);
      }

      console.log("RAW PRICE CANDIDATES:", dedup.slice(0, 200));

      // proximity info
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

      // final price selection
      const finalPrice = selectBestPrice(dedup, proximityInfo);

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

// ---------------- routes ----------------
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

