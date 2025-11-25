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
// 🔥 UNIVERSAL PRICE FIXER — AGORA COM FILTRO DE PREÇOS IRREAIS
function finalizePrice(allValues) {
  if (!Array.isArray(allValues) || allValues.length === 0) return null;

  const nums = allValues
    .map((p) => normalizePrice(p))
    .filter((n) => typeof n === "number" && n > 0);

  if (nums.length === 0) return null;

  // 🔥 FILTRANDO PREÇOS IRREAIS (RESOLVE Riachuelo E QUALQUER OUTRO SITE)
  const realistic = nums.filter((n) => n >= 1 && n <= 20000);

  const finalList = realistic.length > 0 ? realistic : nums;

  const final = Math.min(...finalList);

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
      let rawPrices = [];

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

      if (!title)
        title = await page.$eval(`meta[property="og:title"]`, (e) => e.content).catch(() => null);

      if (!image)
        image = await page.$eval(`meta[property="og:image"]`, (e) => e.content).catch(() => null);

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

      const xhrPrices = collectXHR();
      rawPrices.push(...xhrPrices);

      if (rawPrices.length === 0) {
        const text = await page.evaluate(() => document.body.innerText);
        const m = text.match(/R\$\s?[\d\.,]+/g);
        if (m) rawPrices.push(...m);
      }

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

