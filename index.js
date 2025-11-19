import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// User Agent para simular desktop real e forçar carregamento completo
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const limiter = rateLimit({ windowMs: 10 * 1000, max: 20 });
app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 150;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= 800 || total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: 'pt-BR',
    });

    const page = await context.newPage();
    
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });

      // Espera o preço aparecer (seletor genérico de preço)
      try {
        await page.waitForSelector('[class*="price"], [class*="Price"]', { timeout: 8000 });
      } catch(e) {}

      // Dados iniciais
      let data = { title: null, image: null, price: null, currency: null };

      // 1. Tenta JSON-LD (Melhor fonte)
      try {
        const scripts = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent));
        for (const s of scripts) {
            const json = JSON.parse(s);
            const items = Array.isArray(json) ? json : [json];
            for (const item of items.flat()) {
                if (item && (item['@type'] === 'Product' || item['@type'] === 'ItemPage')) {
                    if (!data.title) data.title = item.name;
                    if (!data.image && item.image) {
                        const img = Array.isArray(item.image) ? item.image[0] : item.image;
                        data.image = typeof img === 'object' ? img.url : img;
                    }
                    if (item.offers) {
                        const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                        // Filtra ofertas que não sejam parcelas (preço muito baixo para ser o total) ou zero
                        const valid = offers.find(o => o.price && parseFloat(o.price) > 0);
                        if (valid) {
                            data.price = valid.price;
                            data.currency = valid.priceCurrency || 'BRL';
                        }
                    }
                }
            }
        }
      } catch(e){}

      // 2. Fallback Visual (Seletor VTEX específico)
      if (!data.price) {
          // Tenta pegar o preço de venda ("Selling Price") e ignora parcelas ("Installments")
          const vtexPrice = await page.$eval('.vtex-product-price-1-x-sellingPriceValue .vtex-product-price-1-x-currencyContainer', el => el.innerText).catch(() => null);
          if (vtexPrice) {
              data.price = vtexPrice.replace(/[^0-9,.]/g, '').replace(',', '.');
              data.currency = 'R$';
          }
      }

      if (!data.title) data.title = await page.title();
      
      // Limpeza de Título (Remove sufixos de site)
      if (data.title) {
          data.title = data.title.split(' | ')[0].split(' - ')[0];
      }

      // Busca de Imagem Robusta
      if (!data.image) {
          // Tenta meta tags OpenGraph
          data.image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
          
          // Se falhar, tenta a primeira imagem grande do corpo
          if (!data.image) {
               data.image = await page.evaluate(() => {
                   const imgs = Array.from(document.querySelectorAll('img'));
                   const large = imgs.find(i => i.naturalWidth > 400 && !i.src.includes('svg'));
                   return large ? large.src : null;
               });
          }
      }

      await browser.close();

      // Formatação Final
      let formattedPrice = null;
      if (data.price) {
          // Lógica de segurança: Se o preço for muito baixo (< 30) e não for um acessório barato, pode ser parcela.
          // Mas vamos confiar no scraper por enquanto.
          if (!String(data.price).includes('R$')) {
              formattedPrice = `R$ ${parseFloat(String(data.price)).toFixed(2).replace('.', ',')}`;
          } else {
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

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/scrape', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
  try { const result = await scrapeProduct(url); res.json(result); } 
  catch (e) { res.status(500).json({success: false, error: e.message}); }
});

async function runGoogleSearch(q) {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop&hl=pt-BR`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1000);
        const items = await page.$$eval('.sh-dgr__content', nodes =>
            nodes.slice(0, 25).map(n => {
                const nameEl = n.querySelector('.tAxDx') || n.querySelector('h4');
                const priceEl = n.querySelector('.a8Pemb') || n.querySelector('.aULzU');
                const imgEl = n.querySelector('img');
                const a = n.querySelector('a');
                return {
                    name: nameEl ? nameEl.textContent?.trim() : null,
                    price: priceEl ? priceEl.textContent?.trim() : null,
                    imageUrl: imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src')) : null,
                    link: a ? a.getAttribute('href') : null
                };
            }).filter(x => x.name)
        );
        const normalized = items.map(i => ({ ...i, link: i.link ? `https://www.google.com${i.link}` : '' }));
        await browser.close();
        return { success: true, results: normalized };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

app.get('/search', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    try { const r = await runGoogleSearch(q); res.json(r); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/search', async (req, res) => {
    const q = (req.body?.query || req.body?.q || '').toString().trim();
    try { const r = await runGoogleSearch(q); res.json(r); } catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

