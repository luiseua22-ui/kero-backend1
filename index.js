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
// finalizePrice agora recebe optional proximityMap (do page.evaluate)
// proximityMap: { "<rawCandidateString>": { near: bool, count: number } }
function finalizePrice(allValues, proximityMap = {}) {
  if (!Array.isArray(allValues) || allValues.length === 0) return null;

  const candidates = allValues
    .map((raw) => {
      const rawStr = raw == null ? "" : String(raw).trim();
      const num = normalizePrice(rawStr);
      return { raw: rawStr, num };
    })
    .filter((c) => c.num !== null);

  if (candidates.length === 0) return null;

  // frequency map for numeric values
  const freq = {};
  for (const c of candidates) {
    const key = c.num.toFixed(2);
    freq[key] = (freq[key] || 0) + 1;
  }

  // scoring function with proximityMap boost
  const scoreFor = (cand) => {
    let score = 0;
    const raw = cand.raw.toLowerCase();

    // strong signal if explicit currency mention
    if (/\br\$/.test(raw) || /\bbrl\b/.test(raw)) score += 6;

    // clean numeric-only low weight
    if (/^[\d\.,]+$/.test(cand.raw)) score += 1;

    // format quality: BR thousands + 2 decimals
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(cand.raw)) score += 5;

    // presence of cents (+)
    if (/[,\.]\d{2}$/.test(cand.raw)) score += 3;

    // indicators of promo/à vista (+)
    if (/\b(vista|de|por|agora|oferta|desconto|promo|preço)\b/.test(raw)) score += 2;

    // penalize installment indications
    if (/parcela|parcelas|installment|juros/.test(raw)) score -= 3;

    // penalize huge numbers slightly
    if (cand.num > 100000) score -= 6;
    else if (cand.num > 20000) score -= 3;

    // frequency boost
    const f = freq[cand.num.toFixed(2)] || 0;
    score += Math.min(f, 5) * 2;

    // penalize raw strings that look like long IDs (many digits no separators)
    if (/^\d{5,}$/.test(cand.raw.replace(/[^\d]/g, "")) && !/[.,]/.test(cand.raw)) score -= 5;

    // PROXIMITY BOOST from page analysis
    const prox = proximityMap[cand.raw];
    if (prox) {
      if (prox.near) score += 10;            // very strong if appears near title/image
      score += Math.min(prox.count, 5) * 1.5; // small boost for occurrences
    }

    // slightly penalize tiny numbers (but not block)
    if (cand.num < 1) score -= 2;

    return score;
  };

  const scored = candidates.map((c) => ({ ...c, score: scoreFor(c) }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = freq[a.num.toFixed(2)] || 0;
    const fb = freq[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    return a.num - b.num;
  });

  const topScore = scored[0].score;
  const topCandidates = scored.filter((s) => s.score === topScore);

  topCandidates.sort((a, b) => {
    const fa = freq[a.num.toFixed(2)] || 0;
    const fb = freq[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    return a.num - b.num;
  });

  const chosen = topCandidates[0];
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

      // ====== NOVO: análise de proximidade no DOM para cada candidato ======
      const uniqueCandidates = Array.from(new Set(rawPrices.map((r) => (r == null ? "" : String(r).trim()))));

      // run in page: for each candidate string, check occurrences and proximity to title/image elements
      const proximityInfo = await page.evaluate(
        (candidates, titleText, imageUrl) => {
          const info = {};
          candidates.forEach((c) => {
            info[c] = { near: false, count: 0 };
          });

          // find title elements (try to match by text)
          const titleEls = [];
          if (titleText && titleText.trim().length > 0) {
            const possible = Array.from(document.querySelectorAll("h1, .product-title, .product-name, .pdp-title"));
            for (const el of possible) {
              try {
                if ((el.innerText || el.textContent || "").trim().includes(titleText.trim())) titleEls.push(el);
              } catch (e) {}
            }
          }

          // find image elements (match src contains imageUrl)
          const imageEls = [];
          if (imageUrl && imageUrl.trim().length > 0) {
            const imgs = Array.from(document.querySelectorAll("img"));
            for (const im of imgs) {
              try {
                const src = im.currentSrc || im.src || "";
                if (src && src.includes(imageUrl)) imageEls.push(im);
              } catch (e) {}
            }
          }

          // any context elements to consider as product area
          const contextEls = [...titleEls, ...imageEls];

          // helper to check proximity: returns true if two elements share an ancestor within depth levels
          function nearEachOther(node, ctxs, maxDepth = 6) {
            if (!node || !ctxs || ctxs.length === 0) return false;
            for (const ctx of ctxs) {
              // quick contains check
              if (ctx.contains(node) || node.contains(ctx)) return true;
              // climb up from node and check if we hit ctx or a common ancestor
              let a = node;
              for (let i = 0; i < maxDepth && a; i++) {
                if (a === ctx) return true;
                a = a.parentElement;
              }
              // climb up from ctx and check
              a = ctx;
              for (let i = 0; i < maxDepth && a; i++) {
                if (a === node) return true;
                a = a.parentElement;
              }
            }
            return false;
          }

          // search the DOM for nodes that contain candidate text (simple contains)
          for (const cand of candidates) {
            if (!cand || cand.trim().length === 0) continue;
            const nodes = Array.from(document.querySelectorAll("body *")).filter((n) => {
              try {
                const t = (n.innerText || n.textContent || "");
                return t && t.includes(cand);
              } catch (e) { return false; }
            });
            info[cand].count = nodes.length;
            if (contextEls.length === 0) {
              // if we don't have title/image anchors, assume proximity unknown (leave near=false)
              continue;
            }
            for (const n of nodes) {
              if (nearEachOther(n, contextEls, 6)) {
                info[cand].near = true;
                break;
              }
            }
          }

          return info;
        },
        uniqueCandidates,
        title || "",
        image || ""
      );

      // FINALIZAÇÃO UNIVERSAL (agora com proximityInfo)
      const finalPrice = finalizePrice(rawPrices, proximityInfo);

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

