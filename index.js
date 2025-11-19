import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// User Agent "Desktop" para evitar versões mobile ou bloqueios
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
      const distance = 200;
      // Scrollar apenas um pouco para triggerar lazy load de imagens do topo
      const maxScroll = 1000; 
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= maxScroll || total >= document.body.scrollHeight) {
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 }, // Viewport desktop ajuda a carregar imagens certas
      locale: 'pt-BR'
    });

    const page = await context.newPage();
    
    try {
      // 1. Navegação inicial
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      
      // 2. ESPERA INTELIGENTE: Tenta esperar por um H1 (título do produto) por até 5 segundos.
      // Sites SPA (como WePink/VTEX) demoram para renderizar o produto.
      try {
        await page.waitForSelector('h1', { timeout: 5000 });
      } catch (e) {
        // Se não achar H1, segue o baile (pode ser site sem H1 explícito)
      }

      // 3. Pequena pausa extra e scroll para garantir imagens
      await page.waitForTimeout(1000); 
      await autoScroll(page);

      let title = null;
      let price = null;
      let priceCurrency = null;
      let image = null;

      // --- ESTRATÉGIA 1: JSON-LD (Dados Estruturados - A Melhor Fonte) ---
      try {
        const scripts = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent));
        
        for (const script of scripts) {
          try {
            const json = JSON.parse(script);
            const objects = Array.isArray(json) ? json : [json];

            for (const obj of objects.flat()) {
              // Prioriza objetos que são explicitamente PRODUTOS
              if (obj && (obj['@type'] === 'Product' || obj['@type'] === 'ItemPage')) {
                if (!title && (obj.name || obj.headline)) {
                    title = obj.name || obj.headline;
                }
                
                if (!image && obj.image) {
                    image = Array.isArray(obj.image) ? obj.image[0] : obj.image;
                    // Se for objeto de imagem, pega a url
                    if (typeof image === 'object' && image.url) image = image.url;
                }

                if (!price && obj.offers) {
                  const offers = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
                  // Tenta achar a oferta com preço
                  const offer = offers.find(o => o.price);
                  if (offer) {
                    price = offer.price;
                    priceCurrency = offer.priceCurrency;
                  }
                }
              }
            }
          } catch(e) {}
        }
      } catch (e) {}

      // --- ESTRATÉGIA 2: Meta Tags (Open Graph / Twitter) ---
      if (!title) {
        title = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => null) ||
                await page.$eval('meta[name="twitter:title"]', el => el.content).catch(() => null);
      }
      if (!image) {
        image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null) ||
                await page.$eval('meta[name="twitter:image"]', el => el.content).catch(() => null);
      }
      if (!price) {
         price = await page.$eval('meta[property="product:price:amount"]', el => el.content).catch(() => null);
         priceCurrency = await page.$eval('meta[property="product:price:currency"]', el => el.content).catch(() => null);
      }

      // --- ESTRATÉGIA 3: Seletores CSS (HTML Visual) ---
      if (!title) {
        title = await page.$eval('h1', el => el.innerText.trim()).catch(() => null) ||
                await page.title().catch(() => null);
      }
      
      // Seletores de preço comuns no Brasil
      if (!price) {
        const priceSelectors = [
            '[itemprop="price"]', 
            '.price', 
            '.product-price', 
            '.sales-price',
            '.vtex-product-price-1-x-currencyInteger' // Específico VTEX/WePink
        ];
        
        for (const sel of priceSelectors) {
            const txt = await page.$eval(sel, el => el.innerText || el.getAttribute('content')).catch(() => null);
            if (txt) {
                // Tenta limpar o texto para achar números
                const match = txt.match(/[0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?/); // Formato PT-BR
                if (match) {
                    price = match[0];
                    break; // Achou um preço, para.
                }
            }
        }
      }

      // Seletores de imagem (tenta pegar a maior imagem visível)
      if (!image) {
        try {
            image = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img'));
                // Filtra imagens muito pequenas (icones, pixels)
                const candidates = imgs.filter(i => i.naturalWidth > 300 && i.naturalHeight > 300);
                if (candidates.length > 0) return candidates[0].src;
                return null;
            });
        } catch(e) {}
      }

      await browser.close();

      // 4. Formatação Final dos Dados
      let priceFinal = null;
      let priceValue = null;

      if (price) {
          const pStr = String(price).trim();
          // Se já vier formatado (ex: 129.90 ou 129,90)
          // Tentativa robusta de parse
          const clean = pStr.replace(/[^\d,.]/g, ''); 
          priceValue = clean;
          
          // Se não tem currency, assume BRL
          const curr = priceCurrency || 'R$';
          
          // Se o preço capturado for apenas o número (ex: 329,00), monta a string
          if (!pStr.includes(curr)) {
              priceFinal = `${curr} ${pStr}`;
          } else {
              priceFinal = pStr;
          }
      }

      return {
        success: true,
        url,
        title: title || "Produto sem título",
        price: priceFinal,
        price_value: priceValue,
        price_currency: priceCurrency,
        image: image
      };

    } catch (err) {
      await browser.close();
      console.error("Scraping error:", err);
      return {
        success: false,
        error: 'Erro no processamento',
        details: err?.message
      };
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
