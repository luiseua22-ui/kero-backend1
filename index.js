import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// URL do seu Backend (Necessário para gerar o deep-link)
const BASE_URL = "https://kero-backend1.onrender.com";

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

// Aumentando concorrência levemente pois agora o scraper é mais leve
// Mas mantendo segurança para não estourar a RAM do Render Free Tier
const queue = new PQueue({ 
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2,
  timeout: 45000 // Timeout reduzido para falhar mais rápido e liberar fila
});

// Lista rotativa de User Agents para evitar detecção simples
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ---------------- SISTEMA DE AFILIADOS (MONETIZAÇÃO BLINDADA) ----------------

app.get("/deep-link", (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.redirect("https://www.google.com");
  }

  let domain = "";
  try {
      domain = new URL(targetUrl).hostname;
  } catch (e) {
      return res.redirect(targetUrl);
  }

  // --- ESTRATÉGIA AMAZON ---
  if (domain.includes("amazon")) {
      try {
          const urlObj = new URL(targetUrl);
          const paramsToRemove = [
              'tag', 'ascsubtag', 'linkCode', 'ref', 'ref_', 'pf_rd_r', 'pf_rd_p', 
              'pf_rd_m', 'pf_rd_s', 'pf_rd_t', 'scm', 'sr', 'qid', 'keywords'
          ];
          paramsToRemove.forEach(p => urlObj.searchParams.delete(p));

          urlObj.searchParams.set('tag', 'kero0a-20');
          const uniqueClickId = `kero_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          urlObj.searchParams.set('ascsubtag', uniqueClickId);

          return res.redirect(302, urlObj.toString());

      } catch (e) {
          console.error("Erro ao processar link Amazon:", e);
          return res.redirect(targetUrl);
      }
  }

  // --- ESTRATÉGIA MERCADO LIVRE (COOKIE DROP) ---
  if (domain.includes("mercadolivre") || domain.includes("mercadolibre")) {
      const ML_TAG = "lo20251209171148";
      const MATT_TOOL = "57996476";

      const socialUrl = `https://www.mercadolivre.com.br/social/${ML_TAG}?matt_word=${ML_TAG}&matt_tool=${MATT_TOOL}`;

      let finalProductUrl = targetUrl;
      try {
          const urlObj = new URL(targetUrl);
          ['click_id', 'wid', 'sid', 'c_id', 'c_uid', 'reco_id', 'reco_backend'].forEach(p => urlObj.searchParams.delete(p));
          urlObj.searchParams.set('matt_tool', MATT_TOOL);
          urlObj.searchParams.set('matt_word', ML_TAG);
          finalProductUrl = urlObj.toString();
      } catch(e) {}

      const html = `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Redirecionando...</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #fff; }
                .loader { border: 3px solid #f3f3f3; border-top: 3px solid #2d3277; border-radius: 50%; width: 24px; height: 24px; animation: spin 0.8s linear infinite; margin-bottom: 16px; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                p { color: #888; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="loader"></div>
            <p>Acessando oferta...</p>
            <iframe src="${socialUrl}" style="display:none;width:0;height:0;border:0;"></iframe>
            <script>
                setTimeout(function() { window.location.replace("${finalProductUrl}"); }, 800);
            </script>
        </body>
        </html>
      `;
      return res.send(html);
  }

  return res.redirect(targetUrl);
});


function generateAffiliateLink(urlInput) {
  if (!urlInput) return urlInput;
  try {
    let urlObj;
    try { urlObj = new URL(urlInput); } catch (e) { return urlInput; }

    if (urlObj.href.includes('/gz/account-verification') || 
        urlObj.href.includes('/suspendida') || 
        urlObj.href.includes('/login')) {
        return urlInput;
    }

    const domain = urlObj.hostname;
    if (domain.includes('amazon') || domain.includes('mercadolivre') || domain.includes('mercadolibre')) {
       const targetUrlEncoded = encodeURIComponent(urlInput);
       return `${BASE_URL}/deep-link?url=${targetUrlEncoded}`;
    }
    return urlInput;
  } catch (error) {
    return urlInput;
  }
}

// ---------------- FUNÇÃO AUXILIAR: BLOCK RESOURCES ----------------
// Isso é CRÍTICO para escalar. Impede o download de imagens e fontes pesadas.
async function configurePageOptimization(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

// ---------------- BUSCA (SEARCH) ----------------

async function searchWithPuppeteer(query) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1366,768", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await configurePageOptimization(page); // Otimização ativada
    
    await page.setUserAgent(getRandomUserAgent());
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1"
    });

    const results = [];
    
    try {
      const mlResults = await searchMercadoLivre(page, query);
      if (mlResults.length > 0) results.push(...mlResults);
    } catch (error) {}
    
    if (results.length < 5) {
      try {
        const amazonResults = await searchAmazon(page, query);
        if (amazonResults.length > 0) results.push(...amazonResults);
      } catch (error) {}
    }

    const uniqueResults = removeDuplicates(results).slice(0, 15);
    if (uniqueResults.length === 0) return getFallbackProducts(query);
    return uniqueResults;

  } catch (error) {
    console.error("Erro busca:", error);
    return getFallbackProducts(query);
  } finally {
    if (browser) await browser.close();
  }
}

async function searchMercadoLivre(page, query) {
  const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    return await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('.ui-search-layout__item, .andes-card, [data-testid="product-card"]');
      for (const element of productElements) {
        try {
          const title = element.querySelector('.ui-search-item__title, h2')?.textContent.trim();
          const price = element.querySelector('.andes-money-amount__fraction, .ui-search-price__part')?.textContent.trim();
          // Imagens podem estar em data-src devido ao lazy load, mas como bloqueamos imagens, pegamos o atributo src mesmo que quebrado visualmente o link existe no DOM
          let image = element.querySelector('img')?.getAttribute('src') || element.querySelector('img')?.getAttribute('data-src');
          const link = element.querySelector('a')?.href.split('?')[0];
          
          if (title && price && link) {
            items.push({ title, price: `R$ ${price}`, store: 'Mercado Livre', imageUrl: image, link });
          }
        } catch(e) {}
        if (items.length >= 8) break;
      }
      return items;
    });
  } catch (error) { return []; }
}

async function searchAmazon(page, query) {
  const searchUrl = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    return await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-component-type="s-search-result"]');
      for (const el of elements) {
        try {
          const title = el.querySelector('h2 a span')?.textContent.trim();
          const whole = el.querySelector('.a-price-whole')?.textContent.trim();
          const image = el.querySelector('.s-image')?.src;
          const link = el.querySelector('h2 a')?.href;
          if (title && whole && link) {
            items.push({ title, price: `R$ ${whole}`, store: 'Amazon', imageUrl: image, link });
          }
        } catch(e) {}
        if (items.length >= 8) break;
      }
      return items;
    });
  } catch (error) { return []; }
}

function removeDuplicates(products) {
  const seen = new Set();
  const unique = [];
  for (const product of products) {
    if (!product.title || !product.price) continue;
    const key = `${product.title.substring(0, 30)}_${product.price}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }
  return unique;
}

function getFallbackProducts(query) {
  return [{
      title: `${query} (Resultado Genérico)`,
      price: 'R$ 0,00',
      store: 'Web',
      imageUrl: '',
      link: `https://www.google.com/search?q=${query}`
  }];
}

// ---------------- SCRAPING INDIVIDUAL ----------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL:", rawUrl);
    
    let browser = null;
    try {
      if (!rawUrl || typeof rawUrl !== 'string') return { success: false, error: "URL inválida" };

      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;

      let monetizedUrl = generateAffiliateLink(url);

      browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"]
      });

      const page = await browser.newPage();
      await configurePageOptimization(page); // Otimização ativada

      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Upgrade-Insecure-Requests": "1"
      });
      
      // Timeout reduzido para 20s para liberar recursos rápido se o site for lento
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

      const pageUrl = page.url();
      let finalUrl = pageUrl;

      if (pageUrl.includes('/gz/account-verification') || 
          pageUrl.includes('/login') || 
          pageUrl.includes('/suspendida')) {
          try {
              const urlObj = new URL(pageUrl);
              const goParam = urlObj.searchParams.get('go');
              finalUrl = goParam ? decodeURIComponent(goParam) : url;
          } catch (e) { finalUrl = url; }
      }

      if (finalUrl !== url) {
          monetizedUrl = generateAffiliateLink(finalUrl);
      }

      const data = await page.evaluate(() => {
        let title = '';
        let price = null;
        let image = '';

        // JSON-LD (Prioridade)
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.innerText);
                if (json['@type'] === 'Product') {
                    if (json.name) title = json.name;
                    if (json.image) image = Array.isArray(json.image) ? json.image[0] : json.image;
                    if (json.offers) {
                        const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
                        if (offer.price) price = offer.price;
                        if (offer.lowPrice) price = offer.lowPrice;
                    }
                }
                if (title && price && image) break;
            } catch(e) {}
        }

        // Seletores Visuais
        if (!title) title = document.getElementById('productTitle')?.innerText?.trim();
        if (!title) title = document.querySelector('h1')?.innerText?.trim();

        if (!image && window.location.hostname.includes('amazon')) {
             const amzImg = document.getElementById('landingImage')?.src ||
                            document.getElementById('imgBlkFront')?.src ||
                            document.querySelector('.a-dynamic-image')?.src;
             // Recupera imagem mesmo se bloqueada pelo request interception (o src ainda está no DOM)
             if (amzImg) image = amzImg;
        }

        if (!image) {
             image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                     document.querySelector('.s-image')?.src;
        }

        if (!price) {
            const priceSelectors = ['.a-price-whole', '.andes-money-amount__fraction', '[data-testid="price-value"]', '.price'];
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.match(/\d/)) {
                    price = el.innerText.trim();
                    if (sel === '.a-price-whole') {
                        const fraction = document.querySelector('.a-price-fraction');
                        if (fraction) price = price + fraction.innerText;
                    }
                    break;
                }
            }
        }

        return { title, price, image };
      });

      await browser.close();

      let formattedPrice = data.price;
      if (formattedPrice) {
          formattedPrice = String(formattedPrice).replace(/\s+/g, ' ').replace('R$', '').trim();
          formattedPrice = `R$ ${formattedPrice}`;
      }

      return {
        success: true,
        url: finalUrl,
        monetized_url: monetizedUrl,
        title: data.title || 'Produto',
        price: formattedPrice || '', 
        image: data.image || ''
      };

    } catch (error) {
      console.error("Scrape Error:", error.message);
      if (browser) await browser.close();
      
      return { 
          success: false, 
          url: rawUrl, 
          monetized_url: generateAffiliateLink(rawUrl), 
          error: "Erro ao ler site" 
      };
    }
  });
}

// ---------------- ROTAS ----------------

app.get("/healthz", (req, res) => res.json({ ok: true, memory: process.memoryUsage() }));

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL obrigatória" });

    if (url.trim().match(/^(http|www\.)/)) {
      const result = await scrapeProduct(url);
      res.json(result);
    } else {
      if (url.trim().length < 2) return res.json([]);
      const products = await searchWithPuppeteer(url);
      res.json(products);
    }
  } catch (error) {
    const safeUrl = req.body?.url || '';
    res.json({
        ...getFallbackProducts(safeUrl)[0],
        monetized_url: generateAffiliateLink(safeUrl)
    });
  }
});

app.get("/test", (req, res) => {
  res.json([{ title: "Teste Backend OK", price: "R$ 1,00", store: "KERO" }]);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🎯 Backend rodando na porta ${PORT}`));
