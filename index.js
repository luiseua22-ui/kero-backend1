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

const queue = new PQueue({
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2,
});

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
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
          for (const k in o) {
            const v = o[k];

            // FILTRA PARCELAMENTO: ignora números pequenos tipo 12 x R$ 609,33
            if (
              (k.toLowerCase().includes("price") ||
                k.toLowerCase().includes("amount") ||
                k.toLowerCase().includes("value")) &&
              (typeof v === "string" || typeof v === "number")
            ) {
              const text = String(v);

              // Se contiver "x" ou "parcel" é parcelado → IGNORA
              if (/(\d+)\s*x/i.test(text) || text.includes("parcel") || text.includes("parcela"))
                continue;

              prices.push(text);
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

// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 🔥 FILTRO DEFINITIVO: IGNORA QUALQUER PREÇO PARCELADO
function isInstallment(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  return (
    t.includes("x") ||
    t.includes("vezes") ||
    t.includes("parcel") ||
    /\d+\s*x/.test(t) ||
    /12x/i.test(t) ||
    /10x/i.test(t) ||
    /(\d+)\s*x\s*R\$/i.test(t)
  );
}

// ------------------------------------------------------------------
function finalizePrice(allValues) {
  if (!Array.isArray(allValues) || allValues.length === 0) return null;

  const filtered = allValues.filter((p) => !isInstallment(String(p)));

  const nums = filtered
    .map((p) => normalizePrice(p))
    .filter((n) => typeof n === "number" && n > 0);

  if (nums.length === 0) return null;

  // Preço real normalmente é o MAIOR valor e não o menor.
  const final = Math.max(...nums);

  return `R$ ${final.toFixed(2).replace(".", ",")}`;
}

// ------------------------------------------------------------------
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

      // ------------------ LD+JSON ------------------
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
                  if (o.price && !isInstallment(o.price)) rawPrices.push(o.price);
                }
              }
            }
          } catch {}
        }
      } catch {}

      // ------------------ og:title & og:image ------------------
      if (!title)
        title = await page.$eval(`meta[property="og:title"]`, (e) => e.content).catch(() => null);

      if (!image)
        image = await page.$eval(`meta[property="og:image"]`, (e) => e.content).catch(() => null);

      // ------------------ HTML selectors ------------------
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
        if (txt && !isInstallment(txt)) rawPrices.push(txt);

        const shadow = await querySelectorShadow(page, sel);
        if (shadow?.text && !isInstallment(shadow.text)) rawPrices.push(shadow.text);
      }

      // ------------------ XHR Prices ------------------
      const xhrPrices = collectXHR();
      rawPrices.push(...xhrPrices);

      // ------------------ BODY TEXT fallback ------------------
      if (rawPrices.length === 0) {
        const text = await page.evaluate(() => document.body.innerText);
        const matches = text.match(/R\$\s?[\d\.,]+/g);
        if (matches) {
          matches.forEach((m) => {
            if (!isInstallment(m)) rawPrices.push(m);
          });
        }
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

// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

