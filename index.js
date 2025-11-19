import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
});
app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

// Função de espera inteligente
async function smartWait(page) {
    // Espera até 8s para ver se o título muda de "Carregando..."
    try {
        await page.waitForFunction(() => {
            const t = (document.title || "").toLowerCase();
            const bad = ['carregando', 'bem-vindo', 'loja', 'vtex'];
            return !bad.some(b => t.includes(b)) && t.length > 10;
        }, { timeout: 8000 });
    } catch(e) {}
    
    // Pequeno scroll para triggerar imagens
    try {
      await page.evaluate(() => window.scrollBy(0, 500));
    } catch(e) {}
    await page.waitForTimeout(1000);
}

async function scrapeProduct(url) {
  return queue.add(async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: 'pt-BR',
    });

    const page = await context.newPage();
    
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
      await smartWait(page);

      // --- ESTRATÉGIA DE DADOS ---
      let data = { title: null, image: null, price: null, currency: null };

      // 1. Extração via JSON-LD (A mais confiável)
      try {
        const scripts = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent));
        for (const s of scripts) {
            try {
                const json = JSON.parse(s);
                const items = Array.isArray(json) ? json : [json];
                for (const item of items.flat()) {
                    if (item && (item['@type'] === 'Product' || item['@type'] === 'ItemPage')) {
                        if (!data.title && item.name) data.title = item.name;
                        if (!data.image && item.image) {
                            const img = Array.isArray(item.image) ? item.image[0] : item.image;
                            data.image = typeof img === 'object' ? img.url : img;
                        }
                        if (item.offers) {
                            const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                            const validOffer = offers.find(o => o.price && parseFloat(o.price) > 0);
                            if (validOffer) {
                                data.price = validOffer.price;
                                data.currency = validOffer.priceCurrency || 'BRL';
                            }
                        }
                    }
                }
            } catch(e){}
        }
      } catch(e){}

      // 2. Extração via Meta Tags (Fallback)
      if (!data.title) data.title = await page.title();
      if (!data.image) data.image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
      
      // 3. Extração Visual (HTML) - Cuidado com preços falsos (frete grátis, parcelas)
      if (!data.price) {
          // Tenta achar o preço principal da VTEX
          const vtexPrice = await page.$eval('.vtex-product-price-1-x-currencyContainer', el => el.innerText).catch(() => null);
          if (vtexPrice) {
             data.price = vtexPrice.replace(/[^0-9,.]/g, '').replace(',', '.');
             data.currency = 'R$';
          }
      }

      // --- LIMPEZA E VALIDAÇÃO ---
      
      // Preço: Remove "Bem-vindo" títulos suspeitos
      if (data.title && data.title.toLowerCase().includes('bem-vindo')) {
          data.price = null; // Preço suspeito
      }

      // Imagem: Garante URL absoluta
      if (data.image && !data.image.startsWith('http')) {
          if (data.image.startsWith('//')) data.image = 'https:' + data.image;
          else data.image = new URL(data.image, url).href;
      }

      // Formatação final do preço
      let formattedPrice = null;
      if (data.price) {
          // Se for numérico (ex: 149.90), formata
          if (!String(data.price).includes('R$')) {
              const num = parseFloat(String(data.price).replace(',', '.'));
              if (!isNaN(num)) {
                  formattedPrice = `R$ ${num.toFixed(2).replace('.', ',')}`;
              } else {
                  formattedPrice = `R$ ${String(data.price).trim()}`;
              }
          } else {
              formattedPrice = data.price;
          }
      }

      await browser.close();

      return {
        success: true,
        url,
        title: data.title || "Título não encontrado",
        price: formattedPrice,
        image: data.image,
      };

    } catch (err) {
      await browser.close();
      return { success: false, error: err.message };
    }
  });
}

// --- ROTAS (Mantenha as rotas /scrape, /healthz e /search como estavam) ---

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/scrape', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
  try {
    const result = await scrapeProduct(url);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: "Erro interno", details: err.message });
  }
});

// Função runGoogleSearch (versão simplificada) e rotas /search

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
    
    // Normaliza links do Google (/url?q=...)
    const normalized = items.map(i => {
        let link = i.link;
        if (link && link.startsWith('/url?q=')) {
            link = link.split('/url?q=')[1].split('&')[0];
            link = decodeURIComponent(link);
        } else if (link && link.startsWith('/')) {
            link = `https://www.google.com${link}`;
        }
        return { ...i, link };
    });

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
  try { const r = await runGoogleSearch(q); res.json(r); } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/search', async (req, res) => {
  const q = (req.body?.query || req.body?.q || '').toString().trim();
  if (!q) return res.status(400).json({ success: false, error: "Query vazia" });
  try { const r = await runGoogleSearch(q); res.json(r); } catch (e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

