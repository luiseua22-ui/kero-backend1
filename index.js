import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// User Agent "Desktop" atualizado conforme solicitado
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
});
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
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      });

      const context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1920, height: 1080 },
        locale: 'pt-BR',
        deviceScaleFactor: 1,
      });

      const page = await context.newPage();
      
      // 1. Navegação
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // 2. TRUQUE PARA SPA (VTEX/WePink): Espera o título mudar do genérico
      try {
        await page.waitForFunction(() => {
            const t = document.title;
            // Lista de títulos genéricos para ignorar e continuar esperando
            const generics = ['bem-vindos', 'carregando', 'loja', 'wepink', 'vtex'];
            if (!t) return false;
            // Se o título NÃO contém as palavras genéricas (ou seja, carregou o produto), retorna true
            return !generics.some(g => t.toLowerCase().includes(g)) || t.length > 40; 
        }, { timeout: 6000 });
      } catch (e) {
        // Se der timeout, tenta esperar pelo seletor de nome de produto comum da VTEX
        try { await page.waitForSelector('.vtex-store-components-3-x-productNameContainer', { timeout: 2000 }); } catch(err){}
      }

      await page.waitForTimeout(1500); // Espera extra para imagens carregarem
      await autoScroll(page);

      // --- EXTRAÇÃO (Mesma lógica robusta, mas agora rodando na hora certa) ---
      let title = null;
      let price = null;
      let priceCurrency = null;
      let image = null;

      // JSON-LD Check (Prioridade Máxima)
      try {
        const scripts = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent));
        for (const script of scripts) {
          try {
             const json = JSON.parse(script);
             const objs = Array.isArray(json) ? json : [json];
             for (const obj of objs.flat()) {
               if (obj && (obj['@type'] === 'Product' || obj['@type'] === 'ItemPage')) {
                 if (obj.name) title = obj.name;
                 if (obj.image) {
                    const img = Array.isArray(obj.image) ? obj.image[0] : obj.image;
                    image = typeof img === 'object' ? img.url : img;
                 }
                 if (obj.offers) {
                    const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
                    if (offer.price) {
                        price = offer.price;
                        priceCurrency = offer.priceCurrency;
                    }
                 }
               }
             }
          } catch(e){}
        }
      } catch(e){}

      // Fallbacks de Seletores
      if (!title) {
        title = await page.title(); // Agora o título deve estar correto
      }
      
      if (!image) {
        image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
      }

      // Preço VTEX específico se JSON-LD falhar
      if (!price) {
         const vtexPrice = await page.$eval('.vtex-product-price-1-x-currencyContainer', el => el.innerText).catch(() => null);
         if (vtexPrice) price = vtexPrice;
      }

      await browser.close();

      // Formatação
      let priceFinal = price ? String(price).trim() : null;
      // Se for numérico puro, formata
      if (price && !String(price).includes(priceCurrency || 'R$')) {
         // Nota: se price estiver em formato brasileiro (ex: "1.234,56"), parseFloat pode não interpretar corretamente.
         // Mantive a lógica conforme solicitado.
         const parsed = parseFloat(String(price));
         if (!isNaN(parsed)) {
           priceFinal = `${priceCurrency || 'R$'} ${parsed.toFixed(2).replace('.', ',')}`;
         } else {
           priceFinal = `${priceCurrency || 'R$'} ${String(price).trim()}`;
         }
      }

      return {
        success: true,
        title: title || "Produto sem título",
        price: priceFinal,
        image: image,
        url
      };

    } catch (err) {
      if (browser) await browser.close();
      return { success: false, error: err?.message || String(err) };
    }
  });
}

// --- ROTAS (Iguais às anteriores) ---

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/scrape', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
  try {
    console.log("Scraping:", url);
    const result = await scrapeProduct(url);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: "Erro interno", details: err?.message });
  }
});

// Helper Search
async function runGoogleSearch(q) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop&hl=pt-BR`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    
    // Espera seletor de resultado
    try { await page.waitForSelector('.sh-dgr__content', { timeout: 5000 }); } catch(e){}

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

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ success: false, error: "Query vazia" });
  try {
    const result = await runGoogleSearch(q);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: "Falha na pesquisa", details: err.message });
  }
});

app.post('/search', async (req, res) => {
  const q = (req.body?.query || req.body?.q || '').toString().trim();
  if (!q) return res.status(400).json({ success: false, error: "Query vazia" });
  try {
    const result = await runGoogleSearch(q);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: "Falha na pesquisa", details: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

