import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";
import { JSDOM } from "jsdom";

const app = express();
app.use(express.json());
app.use(cors());

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 7,
});

app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

// Melhorar a função de scraping para mais sites
async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Múltiplas estratégias para obter título
    const title = await page.evaluate(() => {
      return (
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.querySelector('meta[name="title"]')?.content ||
        document.title?.trim() ||
        "Produto não encontrado"
      );
    });

    // Múltiplas estratégias para obter preço
    const price = await page.evaluate(() => {
      const priceSelectors = [
        '[class*="price"]',
        '.price',
        '[itemprop="price"]',
        '[data-price]',
        '.product-price',
        '.price-current',
        '.sales-price',
        '.final-price'
      ];
      
      for (const selector of priceSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const text = element.innerText?.trim();
          if (text && text.match(/[\d,.]/)) {
            return text.replace(/\s+/g, ' ');
          }
        }
      }
      return null;
    });

    // Múltiplas estratégias para obter imagem
    const image = await page.evaluate(() => {
      return (
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content ||
        document.querySelector('link[rel="image_src"]')?.href ||
        document.querySelector('.product-image img')?.src ||
        document.querySelector('#image img')?.src ||
        document.querySelector('img[alt*="produto"]')?.src ||
        document.querySelector('img[class*="product"]')?.src
      );
    });

    await browser.close();

    return {
      success: true,
      url,
      title: title || "Produto não encontrado",
      price: price || "Preço não disponível",
      image: image || null,
    };
  });
}

// ENDPOINT /search - CORRIGIDO para POST
app.post("/search", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Parâmetro 'query' ausente" });
  }

  try {
    const url = "https://www.google.com/search?tbm=shop&hl=pt-BR&q=" + encodeURIComponent(query);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    const html = await page.content();
    await browser.close();

    const dom = new JSDOM(html);
    const document = dom.window.document;

    const items = [...document.querySelectorAll(".sh-dgr__content, .sh-dlr__content")]
      .slice(0, 15)
      .map(el => {
        const name =
          el.querySelector(".tAxDx")?.textContent?.trim() ||
          el.querySelector(".A2sOrd")?.textContent?.trim() ||
          el.querySelector("h3")?.textContent?.trim() ||
          el.querySelector("h4")?.textContent?.trim() ||
          "Nome não disponível";

        const price =
          el.querySelector(".a8Pemb")?.textContent?.trim() ||
          el.querySelector(".T14wmb")?.textContent?.trim() ||
          el.querySelector('[class*="price"]')?.textContent?.trim() ||
          "Preço não disponível";

        const linkElement = el.querySelector("a");
        const link = linkElement ? 
          (linkElement.href.startsWith("http") ? linkElement.href : "https://www.google.com" + linkElement.getAttribute("href"))
          : null;

        const imageElement = el.querySelector("img");
        const imageUrl = imageElement ? 
          (imageElement.src || imageElement.getAttribute("data-src")) 
          : null;

        return { 
          name, 
          price, 
          link, 
          imageUrl: imageUrl || "https://via.placeholder.com/150?text=Sem+Imagem" 
        };
      })
      .filter(item => item.name && item.link);

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

// Rota principal de scraping
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL ausente" });

  try {
    const data = await scrapeProduct(url);
    res.json(data);
  } catch (err) {
    console.error("Erro no /scrape:", err);
    res.status(500).json({
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
