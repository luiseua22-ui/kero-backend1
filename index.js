import express from "express";
import { chromium } from "playwright";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("Kero Backend v2 Rodando...");
});

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

// ------------------------------------------------------------
// SCROLL PARA LAZY-LOAD DE IMAGENS
// ------------------------------------------------------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 350;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total > document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

// ------------------------------------------------------------
// FUNÇÃO PRINCIPAL DE SCRAPING
// ------------------------------------------------------------
async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1000);
      await autoScroll(page);
      await page.waitForTimeout(300);

      let title = null;
      let price = null;
      let priceCurrency = null;
      let image = null;

      // ----------------------------
      // 1) JSON-LD
      // ----------------------------
      const ldJsons = await page.$$eval(
        'script[type="application/ld+json"]',
        (nodes) => nodes.map((n) => n.textContent)
      );

      for (const txt of ldJsons) {
        try {
          const parsed = JSON.parse(txt);
          const arr = Array.isArray(parsed) ? parsed : [parsed];

          for (const obj of arr.flat()) {
            if (obj["@type"] === "Product") {
              title = title || obj.name || obj.headline || null;

              if (obj.image) {
                image =
                  image ||
                  (Array.isArray(obj.image) ? obj.image[0] : obj.image);
              }

              if (obj.offers) {
                const offer = Array.isArray(obj.offers)
                  ? obj.offers[0]
                  : obj.offers;

                price = price || offer?.price;
                priceCurrency = priceCurrency || offer?.priceCurrency || null;
              }
            }
          }
        } catch {}
      }

      // ----------------------------
      // 2) OG TAGS, <h1>, TITLE
      // ----------------------------
      if (!title) {
        title =
          (await page
            .$eval('meta[property="og:title"]', (el) => el.content)
            .catch(() => null)) ||
          (await page
            .$eval('meta[name="title"]', (el) => el.content)
            .catch(() => null)) ||
          (await page.$eval("h1", (el) => el.innerText).catch(() => null)) ||
          (await page.title().catch(() => null));
      }

      if (!image) {
        image =
          (await page
            .$eval('meta[property="og:image"]', (el) => el.content)
            .catch(() => null)) ||
          (await page
            .$eval('link[rel="image_src"]', (el) => el.href)
            .catch(() => null)) ||
          (await page
            .$eval('[itemprop="image"]', (el) => el.src)
            .catch(() => null));
      }

      // ----------------------------
      // 3) PREÇO
      // ----------------------------
      if (!price) {
        price =
          (await page
            .$eval('[itemprop="price"]', (el) => el.content || el.innerText)
            .catch(() => null)) ||
          (await page
            .$eval('[class*="price"]', (el) => el.innerText)
            .catch(() => null)) ||
          null;
      }

      let price_text = price ? String(price).trim() : null;
      let price_value = null;

      if (price_text) {
        const currencyMatch = price_text.match(
          /(R\$|BRL|USD|\$|EUR|€)/i
        );
        if (currencyMatch) priceCurrency = priceCurrency || currencyMatch[0];

        const numMatch = price_text.match(/[\d\.,]+/);
        if (numMatch) {
          price_value = numMatch[0]
            .replace(/\.(?=\d{3}\b)/g, "")
            .replace(",", ".");
        }
      }

      // ----------------------------
      // 4) FALLBACK DE IMAGEM (evitar logos)
      // ----------------------------
      if (!image) {
        const imgs = await page.$$eval("img", (imgs) =>
          imgs.slice(0, 30).map((i) => ({
            src: i.src || i.getAttribute("data-src") || "",
            w: i.naturalWidth || 0,
            h: i.naturalHeight || 0,
          }))
        );
        const big = imgs.filter((i) => i.w >= 200 && i.h >= 200);
        image = big.length ? big[0].src : imgs[0]?.src || null;
      }

      await browser.close();

      const formattedPrice =
        price_value && priceCurrency
          ? `${priceCurrency} ${price_value.replace(".", ",")}`
          : price_text || null;

      return {
        success: true,
        url,
        title: title || "Título não encontrado",
        price: formattedPrice,
        price_value,
        price_currency: priceCurrency,
        image,
      };
    } catch (err) {
      await browser.close();
      return {
        success: false,
        error: "Erro no scraping",
        details: err.message,
      };
    }
  });
}

// ------------------------------------------------------------
// ENDPOINT /scrape
// ------------------------------------------------------------
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente." });

  const result = await scrapeProduct(url);
  res.json(result);
});

// ------------------------------------------------------------
// ENDPOINT /search (GOOGLE SHOPPING)
// ------------------------------------------------------------
app.get("/search", async (req, res) => {
  const query = (req.query.q || "").toString().trim();
  if (!query)
    return res.status(400).json({ success: false, error: "Query vazia." });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  try {
    const qUrl = `https://www.google.com/search?q=${encodeURIComponent(
      query
    )}&tbm=shop`;

    await page.goto(qUrl, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1200);

    const items = await page.$$eval(
      ".sh-dgr__content",
      (nodes) =>
        nodes.map((n) => {
          const get = (sel, attr = "innerText") => {
            const el = n.querySelector(sel);
            return el ? (attr === "innerText" ? el.innerText : el.getAttribute(attr)) : null;
          };

          return {
            name: get(".tAxDx") || get(".EI11Pd"),
            price: get(".a8Pemb"),
            imageUrl: get("img", "src"),
            link: get("a.shntl", "href"),
          };
        }).filter((x) => x.name)
    );

    const normalized = items.map((i) => ({
      name: i.name,
      price: i.price,
      imageUrl: i.imageUrl,
      link: i.link ? `https://www.google.com${i.link}` : "",
    }));

    await browser.close();
    res.json({ success: true, results: normalized });
  } catch (err) {
    await browser.close();
    res.status(500).json({
      success: false,
      error: "Falha na pesquisa",
      details: err.message,
    });
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend KERO rodando na porta ${PORT}`);
});

