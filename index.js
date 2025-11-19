import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors()); // permite chamadas do front

// User Agent para parecer um navegador real e evitar bloqueios
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Rate limit
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
});
app.use(limiter);

// fila para limitar browsers simultâneos
const queue = new PQueue({ concurrency: 2 });

// útil: scroll para carregar imagens lazy
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 400;
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

// função central de scraping (tenta JSON-LD, og meta, seletores)
async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // CRÍTICO: Usar contexto com User Agent
    const context = await browser.newContext({
      userAgent: USER_AGENT
    });

    const page = await context.newPage();
    
    try {
      // CRÍTICO: 'domcontentloaded' é mais rápido e falha menos que 'networkidle'
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500); // Espera um pouco para JS carregar
      await autoScroll(page);
      await page.waitForTimeout(500);

      let title = null;
      let price = null;
      let priceCurrency = null;
      let image = null;

      // JSON-LD
      try {
        const ld = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent));
        for (const txt of ld) {
          try {
            const parsed = JSON.parse(txt);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const obj of arr.flat ? arr.flat() : arr) {
              if (obj && (obj['@type'] === 'Product' || obj['@type'] === 'ItemPage')) {
                title = title || (obj.name || obj.headline || null);
                if (obj.image) image = image || (Array.isArray(obj.image) ? obj.image[0] : obj.image);
                if (obj.offers) {
                  const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
                  price = price || offer?.price;
                  priceCurrency = priceCurrency || offer?.priceCurrency || null;
                }
              }
            }
          } catch (e) {
            // ignore invalid json
          }
        }
      } catch (e) {}

      // og / meta / h1 / title
      if (!title) {
        title = (await page.$eval('meta[property="og:title"]', el => el.content).catch(() => null)) ||
                (await page.$eval('meta[name="title"]', el => el.content).catch(() => null)) ||
                (await page.$eval('h1', el => el.innerText.trim()).catch(() => null)) ||
                (await page.title().catch(() => null));
      }

      if (!image) {
        image = (await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null)) ||
                (await page.$eval('link[rel="image_src"]', el => el.href).catch(() => null)) ||
                (await page.$eval('[itemprop="image"]', el => el.src).catch(() => null));
      }

      // price selectors
      if (!price) {
        price = (await page.$eval('[itemprop="price"]', el => el.getAttribute('content') || el.innerText).catch(() => null)) ||
                (await page.$eval('[class*="price"]', el => el.innerText).catch(() => null)) ||
                (await page.$eval('[data-price]', el => el.getAttribute('data-price')).catch(() => null)) ||
                null;
      }

      let price_text = price ? String(price).trim() : null;
      let price_value = null;

      if (price_text) {
        const currencyMatch = price_text.match(/(R\$|BRL|USD|\$|EUR|€)/i);
        if (currencyMatch) priceCurrency = priceCurrency || currencyMatch[0];
        const numMatch = price_text.match(/[\d\.,]+/);
        if (numMatch) price_value = numMatch[0].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
      }

      // fallback images: evita logos pegando imagens maiores
      if (!image) {
        const imgs = await page.$$eval('img', imgs => imgs.slice(0, 30).map(i => ({ src: i.src || i.getAttribute('data-src') || '', w: i.naturalWidth || 0, h: i.naturalHeight || 0 })));
        const big = imgs.filter(i => i.w >= 200 && i.h >= 200);
        image = big.length ? big[0].src : imgs[0]?.src || null;
      }

      await browser.close();

      const formattedPrice = price_value && priceCurrency
        ? `${priceCurrency} ${price_value.replace('.', ',')}`
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
      console.error("Scraping error:", err);
      return {
        success: false,
        error: 'Erro no scraping',
        details: err?.message || String(err),
      };
    }
  });
}

// Health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// POST /scrape
app.post('/scrape', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });

  try {
    console.log("Scraping URL:", url);
    const result = await scrapeProduct(url);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: "Erro interno", details: err?.message || String(err) });
  }
});

// Helper para busca no google
async function runGoogleSearch(q) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  
  // User Agent aqui também
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop&hl=pt-BR`;
    
    // domcontentloaded aqui também
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1000);

    const items = await page.$$eval('.sh-dgr__content', nodes =>
      nodes.slice(0, 25).map(n => {
        const nameEl = n.querySelector('.tAxDx') || n.querySelector('h4') || n.querySelector('.EI11Pd');
        const priceEl = n.querySelector('.a8Pemb') || n.querySelector('.aULzU');
        const imgEl = n.querySelector('img');
        const a = n.querySelector('a');
        return {
          name: nameEl ? nameEl.textContent?.trim() : null,
          price: priceEl ? priceEl.textContent?.trim() : null,
          imageUrl: imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : null,
          link: a ? a.getAttribute('href') : null
        };
      }).filter(x => x.name)
    );

    const normalized = items.map(i => ({ name: i.name, price: i.price, imageUrl: i.imageUrl, link: i.link ? `https://www.google.com${i.link}` : '' }));

    await browser.close();
    return { success: true, results: normalized };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// GET /search?q=...
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ success: false, error: "Query vazia" });

  try {
    const result = await runGoogleSearch(q);
    res.json(result);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ success: false, error: "Falha na pesquisa", details: err.message });
  }
});

// POST /search
app.post('/search', async (req, res) => {
  const q = (req.body?.query || req.body?.q || '').toString().trim();
  if (!q) return res.status(400).json({ success: false, error: "Query vazia" });

  try {
    const result = await runGoogleSearch(q);
    return res.json(result);
  } catch (err) {
    console.error("Search POST error:", err);
    return res.status(500).json({ success: false, error: "Falha na pesquisa", details: err.message });
  }
});

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
