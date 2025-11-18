import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";
import { JSDOM } from "jsdom"; // ← NECESSÁRIO PARA O /search

const app = express();
app.use(express.json());
app.use(cors());

// Rate limit — impede abuso
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 7,
});

app.use(limiter);

// Fila para evitar excesso de browsers simultâneos
const queue = new PQueue({ concurrency: 2 });

// Função principal de scraping (para URL)
async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });

    const title =
      (await page.$eval("h1", el => el.innerText.trim()).catch(() => null)) ||
      (await page.$eval("title", el => el.innerText.trim()).catch(() => null));

    const price =
      (await page
        .$eval('[class*="price"], .price, [itemprop="price"]', el =>
          el.innerText.replace(/[^\d,]/g, "")
        )
        .catch(() => null));

    const image =
      (await page.$eval("img", el => el.src).catch(() => null)) ||
      (await page
        .$eval('meta[property="og:image"]', el => el.content)
        .catch(() => null));

    await browser.close();

    return {
      success: true,
      url,
      title: title || "Título não encontrado",
      price: price || null,
      image: image || null,
    };
  });
}

// ===========================================================
// 🚀 NOVO ENDPOINT: /search — busca real com Google Shopping
// ===========================================================

app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();

  if (!q) {
    return res.status(400).json({ error: "Parâmetro 'q' ausente" });
  }

  try {
    // Pesquisa real no Google Shopping
    const url =
      "https://www.google.com/search?tbm=shop&hl=pt-BR&q=" +
      encodeURIComponent(q);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });

    const html = await page.content();
    await browser.close();

    const dom = new JSDOM(html);
    const document = dom.window.document;

    const items = [...document.querySelectorAll(".sh-dgr__content")]
      .slice(0, 15) // ← garante pelo menos 15 itens
      .map(el => {
        const name =
          el.querySelector(".tAxDx")?.textContent?.trim() ||
          el.querySelector("h4")?.textContent?.trim() ||
          null;

        const price =
          el.querySelector(".a8Pemb")?.textContent?.trim() ||
          el.querySelector(".span")?.textContent?.trim() ||
          null;

        const link =
          el.querySelector("a")?.href
            ? "https://www.google.com" +
              el.querySelector("a")?.getAttribute("href")
            : null;

        const imageUrl =
          el.querySelector("img")?.src || el.querySelector("img")?.getAttribute("data-src") || null;

        return { name, price, link, imageUrl };
      })
      .filter(item => item.name && item.link && item.imageUrl);

    if (!items.length) {
      return res.json({
        success: false,
        results: [],
        error: "Nenhum resultado encontrado",
      });
    }

    return res.json({
      success: true,
      results: items,
    });

  } catch (err) {
    console.error("Erro no /search:", err);
    return res.status(500).json({
      success: false,
      error: "Falha ao buscar produtos",
      details: err.message,
    });
  }
});

// ===========================================================

// Rota principal — scrape direto de URL
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL ausente" });

  try {
    const data = await scrapeProduct(url);
    res.json(data);
  } catch (err) {
    res.json({
      success: false,
      error: "Falha ao extrair produto",
      details: err.message,
    });
  }
});

// Healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});

