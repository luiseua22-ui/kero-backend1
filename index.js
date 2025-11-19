import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// User Agent realista
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const limiter = rateLimit({ windowMs: 10 * 1000, max: 20 });
app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

// ====== AUTOSCROLL (para lazy-load) ======
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 150;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
}

// ====== SCRAPER CORRIGIDO / VERSÃO PRO ======
async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
    });

    // Anti-detecção simples
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, "languages", {
        get: () => ["pt-BR", "en-US"],
      });
    });

    const page = await context.newPage();

    try {
      // Navegação mais robusta
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 60000,
      });

      // Espera um pouco para JS tardio
      await page.waitForTimeout(800);

      // Carrega lazy images
      await autoScroll(page);

      // Espera por elementos típicos de preço
      try {
        await page.waitForSelector(
          '[class*="price"], [class*="Price"], [data-testid*="price"], [itemprop="price"]',
          { timeout: 9000 }
        );
      } catch {}

      let data = { title: null, image: null, price: null, currency: null };

      // ====== JSON-LD (com cautela) ======
      try {
        const scripts = await page.$$eval(
          'script[type="application/ld+json"]',
          (nodes) => nodes.map((n) => n.textContent).filter(Boolean)
        );

        for (const s of scripts) {
          try {
            const json = JSON.parse(s);
            const items = Array.isArray(json) ? json : [json];
            for (const item of items.flat()) {
              if (
                item &&
                (item["@type"] === "Product" ||
                  item["@type"] === "Offer" ||
                  item["@type"] === "ItemPage")
              ) {
                if (!data.title && item.name) data.title = item.name;

                if (!data.price && item.offers) {
                  const offers = Array.isArray(item.offers)
                    ? item.offers
                    : [item.offers];
                  const valid = offers.find(
                    (o) =>
                      o.price &&
                      !isNaN(parseFloat(String(o.price))) &&
                      parseFloat(String(o.price)) > 0
                  );
                  if (valid) {
                    data.price = valid.price;
                    data.currency =
                      valid.priceCurrency ||
                      item.offers?.priceCurrency ||
                      "BRL";
                  }
                }

                if (item.image && !data.image) {
                  const img = Array.isArray(item.image)
                    ? item.image[0]
                    : item.image;
                  data.image =
                    typeof img === "object" ? img.url || img.contentUrl : img;
                }
              }
            }
          } catch {}
        }
      } catch {}

      // ====== OG:IMAGE (prioridade para imagem correta) ======
      if (!data.image) {
        data.image = await page
          .$eval('meta[property="og:image"]', (el) => el.content)
          .catch(() => null);
      }

      // ====== GRANDE IMAGEM REAL DO DOM (fallback ultra sólido) ======
      if (!data.image) {
        data.image = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll("img")).filter(
            (i) => i.src && !i.src.includes("svg")
          );
          if (!imgs.length) return null;
          let best = imgs[0];
          let bestSize =
            (imgs[0].naturalWidth || 0) * (imgs[0].naturalHeight || 0);
          for (const img of imgs) {
            const size =
              (img.naturalWidth || 0) * (img.naturalHeight || 0);
            if (size > bestSize) {
              best = img;
              bestSize = size;
            }
          }
          return best ? best.currentSrc || best.src : null;
        });
      }

      // ====== COLETA DE PREÇO (multi-tentativas) ======
      const selectors = [
        "meta[itemprop='price']",
        "meta[property='product:price:amount']",
        "[data-testid*='price']",
        "[itemprop='price']",
        ".vtex-product-price-1-x-sellingPriceValue",
        "[class*='price']",
        "[class*='Price']",
      ];

      if (!data.price) {
        for (const sel of selectors) {
          try {
            const raw = await page
              .$eval(sel, (el) => el.innerText || el.content || el.value)
              .catch(() => null);
            if (raw) {
              const found = String(raw).match(/[\d\.,]+/g);
              if (found) {
                data.price = found[0];
                break;
              }
            }
          } catch {}
        }
      }

      // Último fallback: texto da página
      if (!data.price) {
        const body = await page.evaluate(() => document.body.innerText);
        const match =
          body.match(/R\$\s?[\d\.,]+/) ||
          body.match(/[\d\.,]+\s?R\$/);
        if (match) data.price = match[0];
      }

      // ====== TÍTULO ======
      if (!data.title) data.title = await page.title();
      if (data.title) {
        data.title = data.title.split(" | ")[0].split(" - ")[0].trim();
      }

      await browser.close();

      // ====== FORMATAÇÃO DE PREÇO ======
      let formattedPrice = null;
      if (data.price) {
        try {
          let clean = String(data.price)
            .replace(/\s/g, "")
            .replace(/[^\d\.,]/g, "");

          clean = clean
            .replace(/\.(?=.*\.)/g, "")
            .replace(/,(?=.*,)/g, ".");

          const n = parseFloat(clean.replace(",", "."));

          if (!isNaN(n)) {
            formattedPrice = `R$ ${n
              .toFixed(2)
              .replace(".", ",")}`;
          } else {
            formattedPrice = data.price;
          }
        } catch {
          formattedPrice = data.price;
        }
      }

      return {
        success: true,
        url,
        title: data.title || "Produto",
        price: formattedPrice,
        image: data.image,
      };
    } catch (err) {
      await browser.close();
      return { success: false, error: err.message };
    }
  });
}

// ========= ROTAS =========
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url)
    return res.status(400).json({ success: false, error: "URL ausente" });

  try {
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====== GOOGLE SHOPPING SCRAPER ======
async function runGoogleSearch(q) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
  });

  const page = await context.newPage();
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(
      q
    )}&tbm=shop&hl=pt-BR`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1000);

    const items = await page.$$eval(".sh-dgr__content", (nodes) =>
      nodes
        .slice(0, 25)
        .map((n) => {
          const nameEl = n.querySelector(".tAxDx") || n.querySelector("h4");
          const priceEl =
            n.querySelector(".a8Pemb") || n.querySelector(".aULzU");
          const imgEl = n.querySelector("img");
          const a = n.querySelector("a");

          return {
            name: nameEl ? nameEl.textContent.trim() : null,
            price: priceEl ? priceEl.textContent.trim() : null,
            imageUrl: imgEl
              ? imgEl.getAttribute("src") || imgEl.getAttribute("data-src")
              : null,
            link: a ? a.getAttribute("href") : null,
          };
        })
        .filter((x) => x.name)
    );

    const normalized = items.map((i) => ({
      ...i,
      link: i.link ? `https://www.google.com${i.link}` : "",
    }));

    await browser.close();
    return { success: true, results: normalized };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  try {
    const r = await runGoogleSearch(q);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/search", async (req, res) => {
  const q = (req.body?.query || req.body?.q || "").toString().trim();
  try {
    const r = await runGoogleSearch(q);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Backend rodando na porta ${PORT}`)
);
