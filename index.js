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

// Autoscroll para lazy-load
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 150;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
}

// --- Função utilitária: sanitiza/normaliza URL recebida ---
function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();

  // Se houver múltiplas ocorrências de "http" dentro da string (ex: concatenação acidental),
  // pega a *primeira* ocorrência que pareça correta (ou, se houver lixo antes, pega a última).
  // Estratégia: localizar o primeiro "http" e o último "http" — escolher o primeiro válido que parseie.
  const httpMatches = [...s.matchAll(/https?:\/\/[^ \n\r\t]+/gi)].map(m => m[0]);
  if (httpMatches.length > 0) {
    // tenta cada match até encontrar uma URL válida
    for (const cand of httpMatches) {
      try {
        const u = new URL(cand);
        return u.toString();
      } catch (e) { /* continua */ }
    }
    // se nenhum match parseou como URL, cai para tentativa abaixo
  }

  // Se não encontramos um trecho com http(s) acima, pode ser que a string contenha "https://...phttps://..."
  // então procuramos pela primeira ocorrência de "http" e cortamos dali até o final real (retirando repetidos)
  const firstHttp = s.search(/https?:\/\//i);
  if (firstHttp >= 0) {
    s = s.slice(firstHttp);
  }

  // Remove possíveis ocorrências adicionais anexadas (ex: ".../phttps://domain.com")
  // Se houver outra "http" no meio, cortamos a partir da primeira.
  const secondHttpIndex = s.indexOf("http", 1);
  if (secondHttpIndex > 0) {
    s = s.slice(0, secondHttpIndex); // mantém apenas a primeira URL aparente
  }

  // Se ainda não tem protocolo, adiciona "https://"
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }

  // tentativa final de construir URL
  try {
    const u = new URL(s);
    return u.toString();
  } catch (e) {
    return null;
  }
}

// --- SCRAPE (robusto, com retries de navegação e sanitização de URL) ---
async function scrapeProduct(url) {
  return queue.add(async () => {
    // Sanitiza entrada imediatamente
    const cleanUrl = sanitizeIncomingUrl(url);
    if (!cleanUrl) {
      return { success: false, error: "URL malformada ou não pôde ser interpretada." };
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
    });

    // Anti-detection simples
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, "languages", {
        get: () => ["pt-BR", "en-US"],
      });
    });

    const page = await context.newPage();

    try {
      // Tenta navegar com networkidle primeiro (mais robusto). Se timeout, faz fallback.
      let navigated = false;
      try {
        await page.goto(cleanUrl, { waitUntil: "networkidle", timeout: 60000 });
        navigated = true;
      } catch (navErr) {
        // Caso de timeout — tenta fallback com domcontentloaded e espera extra
        console.warn("networkidle failed, retrying with domcontentloaded:", navErr.message);
        try {
          await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          // espera um pouco mais para scripts carregarem
          await page.waitForTimeout(1200);
          navigated = true;
        } catch (navErr2) {
          console.error("Fallback navigation also failed:", navErr2.message);
          // devolve erro claro ao front
          await browser.close();
          return { success: false, error: `Falha ao navegar para a URL (timeout). URL: ${cleanUrl}` };
        }
      }

      // Se navegou, força carregamento lazy
      if (navigated) {
        await page.waitForTimeout(600);
        await autoScroll(page);
      }

      // Tenta detectar preço seletivamente (espera curta por seletor típico)
      try {
        await page.waitForSelector('[class*="price"], [class*="Price"], [data-testid*="price"], [itemprop="price"]', { timeout: 9000 });
      } catch (e) { /* continua sem travar */ }

      let data = { title: null, image: null, price: null, currency: null };

      // 1) JSON-LD
      try {
        const scripts = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
        for (const s of scripts) {
          try {
            const json = JSON.parse(s);
            const items = Array.isArray(json) ? json : [json];
            for (const item of items.flat()) {
              if (item && (item['@type'] === 'Product' || item['@type'] === 'Offer' || item['@type'] === 'ItemPage')) {
                if (!data.title && item.name) data.title = item.name;
                if (!data.price && item.offers) {
                  const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                  const valid = offers.find(o => o.price && !isNaN(parseFloat(String(o.price))) && parseFloat(String(o.price)) > 0);
                  if (valid) { data.price = valid.price; data.currency = valid.priceCurrency || 'BRL'; }
                }
                if (item.image && !data.image) {
                  const img = Array.isArray(item.image) ? item.image[0] : item.image;
                  data.image = typeof img === 'object' ? img.url || img.contentUrl : img;
                }
              }
            }
          } catch (jsonErr) { /* ignora json inválido */ }
        }
      } catch (e) {}

      // 2) og:image
      if (!data.image) {
        data.image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
      }

      // 3) maior imagem do DOM
      if (!data.image) {
        data.image = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.src && !i.src.includes('svg'));
          if (!imgs.length) return null;
          let best = imgs[0];
          let bestSize = (imgs[0].naturalWidth || 0) * (imgs[0].naturalHeight || 0);
          for (const img of imgs) {
            const size = (img.naturalWidth || 0) * (img.naturalHeight || 0);
            if (size > bestSize) { best = img; bestSize = size; }
          }
          return best ? (best.currentSrc || best.src) : null;
        });
      }

      // 4) busca de preço por seletores variados
      const selectors = [
        'meta[itemprop="price"]',
        'meta[property="product:price:amount"]',
        '[data-testid*="price"]',
        '[itemprop="price"]',
        '.vtex-product-price-1-x-sellingPriceValue',
        '[class*="price"]',
        '[class*="Price"]',
        '.priceblock_ourprice'
      ];

      if (!data.price) {
        for (const sel of selectors) {
          try {
            const raw = await page.$eval(sel, el => el.innerText || el.content || el.value).catch(() => null);
            if (raw) {
              const found = String(raw).match(/[\d\.,]+/g);
              if (found && found.length) {
                data.price = found[0];
                break;
              }
            }
          } catch (e) { /* continua */ }
        }
      }

      // 5) fallback: texto da página
      if (!data.price) {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const m = bodyText.match(/R\$\s?[\d\.,]+|[\d\.,]+\s?R\$/);
        if (m) data.price = m[0];
        else {
          const n = bodyText.match(/[\d]{1,3}(?:[\.,]\d{2})/g);
          if (n && n.length) data.price = n[0];
        }
      }

      // 6) título fallback
      if (!data.title) data.title = await page.title();
      if (data.title) data.title = data.title.split(' | ')[0].split(' - ')[0].trim();

      await browser.close();

      // Formata preço
      let formattedPrice = null;
      if (data.price) {
        try {
          let clean = String(data.price).replace(/\s/g, '').replace(/[^\d\.,]/g, '');
          clean = clean.replace(/\.(?=.*\.)/g, '').replace(/,(?=.*,)/g, '.');
          const n = parseFloat(clean.replace(',', '.'));
          if (!isNaN(n)) formattedPrice = `R$ ${n.toFixed(2).replace('.', ',')}`;
          else formattedPrice = data.price;
        } catch { formattedPrice = data.price; }
      }

      return { success: true, url: cleanUrl, title: data.title || "Produto", price: formattedPrice, image: data.image };
    } catch (err) {
      await browser.close();
      return { success: false, error: String(err) };
    }
  });
}

// Rotas
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/scrape', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ success: false, error: "URL ausente" });
  try {
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Google Shopping scrape (mantive igual)
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

