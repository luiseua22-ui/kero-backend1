import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

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

// Função principal de scraping
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

// Rota principal
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
