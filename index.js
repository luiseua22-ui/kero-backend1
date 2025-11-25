import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const app = express();
app.use(cors());
app.use(express.json());

// Ativa o Stealth
puppeteer.use(StealthPlugin());

// ──────────────────────────────────────────────────────────────
// Sanitização de URL
// ──────────────────────────────────────────────────────────────
function limparURL(url) {
  try {
    const regex = /(https?:\/\/[^\s]+)/g;
    const match = url.match(regex);

    if (match && match.length > 0) {
      return match[0];
    }

    return url.trim();
  } catch {
    return url.trim();
  }
}

// ──────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL DE SCRAPING
// ──────────────────────────────────────────────────────────────
async function scrapePage(url) {
  console.log("URL RECEBIDA:", url);

  const cleanUrl = limparURL(url);
  console.log("URL LIMPA:", cleanUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-http2",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080",
    ]
  });

  const page = await browser.newPage();

  // Melhor fingerprint possível
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    // Tentativa com timeout reduzido
    await page.goto(cleanUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Espera script dinamicamente renderizar conteúdo
    await page.waitForTimeout(1500);

    // Pega título
    const title =
      await page.evaluate(() => {
        const possible = [
          "h1", ".product-title", ".product-name", "meta[property='og:title']"
        ];

        for (let sel of possible) {
          const el = document.querySelector(sel);
          if (!el) continue;

          if (el.tagName === "META") return el.content;
          return el.innerText.trim();
        }

        return null;
      });

    // Pega preço
    const price = await page.evaluate(() => {
      const selectors = [
        ".price", ".product-price", ".value", ".finalPrice", ".sales-price",
        "[itemprop='price']", "meta[property='product:price:amount']"
      ];

      for (let sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;

        if (el.tagName === "META") return el.getAttribute("content");

        return el.innerText.trim();
      }

      return null;
    });

    // Pega imagem
    const image = await page.evaluate(() => {
      const sel = [
        "img#product-image", ".product-image img", ".pdp-image img",
        "meta[property='og:image']"
      ];

      for (let s of sel) {
        const el = document.querySelector(s);
        if (!el) continue;

        if (el.tagName === "META") return el.content;

        return el.src;
      }

      return null;
    });

    await browser.close();

    return {
      title: title || "Título não encontrado",
      price: price || "Preço não encontrado",
      image: image || "Imagem não encontrada"
    };

  } catch (err) {
    console.error("ERRO NO SCRAPING:", err.message);
    await browser.close();
    return { error: "Falha ao carregar página", details: err.message };
  }
}

// ──────────────────────────────────────────────────────────────
// ROTA API
// ──────────────────────────────────────────────────────────────
app.post("/scrape", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL não fornecida" });
    }

    const result = await scrapePage(url);
    res.json(result);

  } catch (error) {
    res.status(500).json({ error: "Erro interno", details: error.message });
  }
});

// ──────────────────────────────────────────────────────────────

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000");
});
