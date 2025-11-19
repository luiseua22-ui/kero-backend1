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

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 180;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 130);
    });
  });
}

/* ============================================================
   🛠️ SANITIZADOR DE URL – Remoção total de URLs duplicadas
=============================================================== */
function sanitizeIncomingUrl(raw) {
  if (!raw) return null;

  let s = raw.trim();

  // Captura TODAS as URLs válidas
  const urls = [...s.matchAll(/https?:\/\/[^\s"]+/g)].map(m => m[0]);

  // Se houver ao menos uma URL válida → usar a primeira
  if (urls.length > 0) return urls[0];

  // Fallback: tenta prefixar
  if (!s.startsWith("http")) s = "https://" + s;

  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

/* ============================================================
   🎯 SCRAPER PRINCIPAL
=============================================================== */
async function scrapeProduct(url) {
  return queue.add(async () => {
    const cleanUrl = sanitizeIncomingUrl(url);

    console.log("URL RECEBIDA:", url);
    console.log("URL LIMPA:", cleanUrl);

    if (!cleanUrl) {
      return { success: false, error: "URL inválida após sanitização." };
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR"
    });

    // Anti-bot simples
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en"] });
      window.chrome = window.chrome || { runtime: {} };
    });

    const page = await context.newPage();

    try {
      /* -----------------------------------------------------------
         🧭 SUPER NAVEGAÇÃO (tolerância total para VTEX/Wepink)
      ------------------------------------------------------------ */
      try {
        await page.goto(cleanUrl, {
          waitUntil: "domcontentloaded",
          timeout: 120000
        });

        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await autoScroll(page);

      } catch (err) {
        console.error("Erro ao navegar:", err.message);
        await browser.close();
        return { success: false, error: "Falha ao carregar página (timeout)." };
      }

      /* -----------------------------------------------------------
         EXTRA: aguarda possíveis carregamentos atrasados da VTEX
      ------------------------------------------------------------ */
      await page.waitForTimeout(1200);

      /* -----------------------------------------------------------
         🧠 OBJETO DE RETORNO
      ------------------------------------------------------------ */
      let data = { title: null, price: null, image: null };

      /* -----------------------------------------------------------
         1) JSON-LD (mais preciso)
      ------------------------------------------------------------ */
      try {
        const scripts = await page.$$eval(
          'script[type="application/ld+json"]',
          nodes => nodes.map(n => n.textContent)
        );

        for (const block of scripts) {
          try {
            const json = JSON.parse(block);
            const items = Array.isArray(json) ? json : [json];

            for (const item of items.flat()) {
              if (item["@type"] === "Product") {
                if (!data.title && item.name) data.title = item.name;

                if (!data.image && item.image) {
                  const img = Array.isArray(item.image) ? item.image[0] : item.image;
                  data.image = typeof img === "object" ? img.url || img.contentUrl : img;
                }

                if (item.offers) {
                  const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                  const valid = offers.find(o =>
                    o.price && parseFloat(o.price) > 0
                  );
                  if (valid) data.price = valid.price;
                }
              }
            }
          } catch {}
        }
      } catch {}

      /* -----------------------------------------------------------
         2) OpenGraph Image
      ------------------------------------------------------------ */
      if (!data.image) {
        data.image = await page.$eval(
          'meta[property="og:image"]',
          el => el.content
        ).catch(() => null);
      }

      /* -----------------------------------------------------------
         3) Maior imagem da página (fallback final)
      ------------------------------------------------------------ */
      if (!data.image) {
        data.image = await page.evaluate(() => {
          const imgs = [...document.querySelectorAll("img")];
          const valid = imgs.filter(i => i.naturalWidth > 200);
          if (!valid.length) return null;

          let best = valid[0];
          let bestArea = best.naturalWidth * best.naturalHeight;

          for (const img of valid) {
            const area = img.naturalWidth * img.naturalHeight;
            if (area > bestArea) {
              best = img;
              bestArea = area;
            }
          }

          return best.src || best.currentSrc;
        });
      }

      /* -----------------------------------------------------------
         4) Captura de preço — MULTI-SELETOR
      ------------------------------------------------------------ */
      if (!data.price) {
        const selectors = [
          '[itemprop="price"]',
          '[data-testid*="price"]',
          '.vtex-product-price-1-x-sellingPriceValue',
          '.vtex-product-price-1-x-currencyContainer',
          '.price',
          '.Price',
          '.productPrice'
        ];

        for (const sel of selectors) {
          try {
            const txt = await page.$eval(sel, el => el.innerText || el.content).catch(() => null);
            if (!txt) continue;

            const match = txt.match(/[\d\.,]+/);
            if (match) {
              data.price = match[0];
              break;
            }
          } catch {}
        }
      }

      /* -----------------------------------------------------------
         5) Título fallback
      ------------------------------------------------------------ */
      if (!data.title) {
        data.title = (await page.title()).split("|")[0].split("-")[0].trim();
      }

      await browser.close();

      /* -----------------------------------------------------------
         6) Formatação final do preço
      ------------------------------------------------------------ */
      let finalPrice = null;
      if (data.price) {
        const clean = data.price.replace(/\./g, "").replace(",", ".");
        const n = parseFloat(clean);
        if (!isNaN(n)) {
          finalPrice = `R$ ${n.toFixed(2).replace(".", ",")}`;
        }
      }

      return {
        success: true,
        title: data.title,
        price: finalPrice,
        image: data.image,
        url: cleanUrl
      };

    } catch (err) {
      await browser.close();
      return { success: false, error: err.message };
    }
  });
}

/* ============================================================
   ROTAS
=============================================================== */
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

/* ============================================================
   GOOGLE SHOPPING (igual ao original)
=============================================================== */
async function runGoogleSearch(q) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(
      q
    )}&tbm=shop&hl=pt-BR`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1200);

    const items = await page.$$eval(".sh-dgr__content", (nodes) =>
      nodes.slice(0, 25).map((n) => {
        const nameEl = n.querySelector(".tAxDx") || n.querySelector("h4");
        const priceEl = n.querySelector(".a8Pemb") || n.querySelector(".aULzU");
        const imgEl = n.querySelector("img");
        const a = n.querySelector("a");

        return {
          name: nameEl?.textContent?.trim() || null,
          price: priceEl?.textContent?.trim() || null,
          imageUrl: imgEl?.src || imgEl?.getAttribute("data-src") || null,
          link: a ? "https://www.google.com" + a.getAttribute("href") : null
        };
      })
    );

    await browser.close();
    return { success: true, results: items.filter((i) => i.name) };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

app.get("/search", async (req, res) => {
  try {
    const r = await runGoogleSearch(String(req.query.q || ""));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/search", async (req, res) => {
  try {
    const r = await runGoogleSearch(String(req.body?.q || req.body?.query || ""));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   SERVER
=============================================================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Backend rodando na porta ${PORT}`)
);

