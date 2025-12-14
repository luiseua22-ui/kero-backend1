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

// URL do seu Backend
const BASE_URL = "https://kero-backend1.onrender.com";

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

const queue = new PQueue({ 
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 1,
  timeout: 60000 
});

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------------- AFILIADOS ----------------

app.get("/deep-link", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect("https://www.google.com");

  let domain = "";
  try { domain = new URL(targetUrl).hostname; } catch (e) { return res.redirect(targetUrl); }

  if (domain.includes("amazon")) {
      try {
          const urlObj = new URL(targetUrl);
          const paramsToRemove = ['tag', 'ascsubtag', 'linkCode', 'ref', 'ref_', 'pf_rd_r', 'pf_rd_p', 'pf_rd_m', 'pf_rd_s', 'pf_rd_t', 'scm', 'sr', 'qid', 'keywords'];
          paramsToRemove.forEach(p => urlObj.searchParams.delete(p));
          urlObj.searchParams.set('tag', 'kero0a-20');
          const uniqueClickId = `kero_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          urlObj.searchParams.set('ascsubtag', uniqueClickId);
          return res.redirect(302, urlObj.toString());
      } catch (e) { return res.redirect(targetUrl); }
  }

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

      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Redirecionando...</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background-color:#fff}.loader{border:3px solid #f3f3f3;border-top:3px solid #2d3277;border-radius:50%;width:24px;height:24px;animation:spin 0.8s linear infinite;margin-bottom:16px}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}p{color:#888;font-size:14px}</style></head><body><div class="loader"></div><p>Acessando oferta...</p><iframe src="${socialUrl}" style="display:none;width:0;height:0;border:0;"></iframe><script>setTimeout(function(){window.location.replace("${finalProductUrl}");},1000);</script></body></html>`;
      return res.send(html);
  }
  return res.redirect(targetUrl);
});

function generateAffiliateLink(urlInput) {
  if (!urlInput) return urlInput;
  try {
    const urlObj = new URL(urlInput);
    if (urlObj.href.includes('/gz/account-verification') || urlObj.href.includes('/suspendida') || urlObj.href.includes('/login')) return urlInput;
    const domain = urlObj.hostname;
    if (domain.includes('amazon') || domain.includes('mercadolivre') || domain.includes('mercadolibre')) {
       return `${BASE_URL}/deep-link?url=${encodeURIComponent(urlInput)}`;
    }
    return urlInput;
  } catch (error) { return urlInput; }
}

// ---------------- BUSCA (PUPPETEER) ----------------

async function searchWithPuppeteer(query) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1366,768"],
  });

  const page = await browser.newPage();
  try {
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1"
    });

    const results = [];
    try {
      const mlResults = await searchMercadoLivre(page, query);
      if (mlResults.length > 0) results.push(...mlResults);
    } catch (e) {}
    
    if (results.length < 5) {
      try {
        const amazonResults = await searchAmazon(page, query);
        if (amazonResults.length > 0) results.push(...amazonResults);
      } catch (e) {}
    }

    const uniqueResults = removeDuplicates(results).slice(0, 15);
    if (uniqueResults.length === 0) return getFallbackProducts(query);
    return uniqueResults;
  } catch (error) {
    return getFallbackProducts(query);
  } finally {
    if (browser) await browser.close();
  }
}

async function searchMercadoLivre(page, query) {
  const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    return await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('.ui-search-layout__item, .andes-card, [data-testid="product-card"]');
      for (const element of productElements) {
        try {
          const title = element.querySelector('.ui-search-item__title, h2')?.textContent.trim();
          const price = element.querySelector('.andes-money-amount__fraction, .ui-search-price__part')?.textContent.trim();
          const image = element.querySelector('img')?.getAttribute('src');
          const link = element.querySelector('a')?.href.split('?')[0];
          if (title && price && link) items.push({ title, price: `R$ ${price}`, store: 'Mercado Livre', imageUrl: image, link });
        } catch(e) {}
        if (items.length >= 8) break;
      }
      return items;
    });
  } catch (e) { return []; }
}

async function searchAmazon(page, query) {
  const searchUrl = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    return await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-component-type="s-search-result"]');
      for (const el of elements) {
        try {
          const title = el.querySelector('h2 a span')?.textContent.trim();
          const whole = el.querySelector('.a-price-whole')?.textContent.trim();
          const image = el.querySelector('.s-image')?.src;
          const link = el.querySelector('h2 a')?.href;
          if (title && whole && link) items.push({ title, price: `R$ ${whole}`, store: 'Amazon', imageUrl: image, link });
        } catch(e) {}
        if (items.length >= 8) break;
      }
      return items;
    });
  } catch (e) { return []; }
}

function removeDuplicates(products) {
  const seen = new Set();
  const unique = [];
  for (const product of products) {
    if (!product.title || !product.price) continue;
    const key = `${product.title.substring(0, 30)}_${product.price}`;
    if (!seen.has(key)) { seen.add(key); unique.push(product); }
  }
  return unique;
}

function getFallbackProducts(query) {
  return [{ title: `${query} (Resultado Genérico)`, price: 'R$ 0,00', store: 'Web', imageUrl: '', link: `https://www.google.com/search?q=${query}` }];
}

// ---------------- SCRAPING INDIVIDUAL (ROBUSTO) ----------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL:", rawUrl);
    let browser = null;
    try {
      if (!rawUrl || typeof rawUrl !== 'string') return { success: false, error: "URL inválida" };
      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;

      // CONVERSÃO E LIMPEZA DE URL SHEIN
      if (url.includes('shein.com')) {
          // Remove parâmetros inúteis que atrapalham o scraping
          try {
              const u = new URL(url);
              // m.shein -> www.shein
              if (u.hostname === 'm.shein.com') {
                  u.hostname = 'www.shein.com';
              }
              // Manter apenas ID se possível, ou params essenciais
              const keepParams = ['goods_id', 'id']; 
              const newParams = new URLSearchParams();
              u.searchParams.forEach((val, key) => {
                 if (key.includes('id') || keepParams.includes(key)) {
                     newParams.set(key, val);
                 }
              });
              // Se tiver algo como /p-12345.html, o ID já está na URL
              url = u.toString();
          } catch(e) {}
      }

      let monetizedUrl = generateAffiliateLink(url);

      browser = await puppeteer.launch({
        headless: "new",
        args: [
            "--no-sandbox", 
            "--disable-setuid-sandbox", 
            "--window-size=1920,1080",
            "--disable-features=IsolateOrigins,site-per-process",
            "--blink-settings=imagesEnabled=true"
        ]
      });

      const page = await browser.newPage();
      
      // USER AGENT DE DESKTOP É ESSENCIAL PARA SHEIN
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
      
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache"
      });
      
      // Bloqueia recursos inúteis para acelerar e evitar detecção
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const rType = req.resourceType();
        if (['font', 'media', 'websocket'].includes(rType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Timeout maior para Shein
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      
      // Pega HTML bruto para Regex Mining (Mais confiável que DOM)
      const content = await page.content();
      const pageUrl = page.url();
      let finalUrl = pageUrl;

      // ------------------ SHEIN REGEX MINING ------------------
      if (url.includes('shein.com') || pageUrl.includes('shein.com')) {
          let title, price, image;

          // 1. Título via Regex
          // Procura por "goods_name":"..." ou <title>...</title>
          const titleMatch = content.match(/"goods_name"\s*:\s*"(.*?)"/) || 
                             content.match(/<h1[^>]*class="[^"]*product-intro__head-name[^"]*"[^>]*>(.*?)<\/h1>/) ||
                             content.match(/<title>(.*?)<\/title>/);
          if (titleMatch) title = titleMatch[1];

          // 2. Imagem via Regex
          // Procura por "original_img":"..." ou "main_image": "..."
          const imgMatch = content.match(/"original_img"\s*:\s*"(.*?)"/) || 
                           content.match(/"main_image"\s*:\s*\{\s*"origin_image"\s*:\s*"(.*?)"/) ||
                           content.match(/property="og:image"\s+content="(.*?)"/);
          
          if (imgMatch) {
              image = imgMatch[1];
              // Limpeza comum da Shein
              if (image.startsWith('//')) image = 'https:' + image;
              image = image.replace(/_thumbnail_\d+x\d+/, ''); // Pega full resolution
              image = image.replace(/_220x293/, ''); 
          }

          // 3. Preço via Regex
          // Procura por "salePrice":{"amount":"..."} ou "retailPrice"
          const priceMatch = content.match(/"salePrice"\s*:\s*\{\s*"amount"\s*:\s*"(\d+\.?\d*)"/) || 
                             content.match(/"retailPrice"\s*:\s*\{\s*"amount"\s*:\s*"(\d+\.?\d*)"/) ||
                             content.match(/"amountWithSymbol"\s*:\s*"(.*?)"/);
          
          if (priceMatch) {
             price = priceMatch[1];
             if (!price.includes('R$') && !price.includes('$')) {
                 price = `R$ ${price}`;
             }
          }

          // Fallback final no DOM se regex falhar
          if (!title || !price) {
             const domData = await page.evaluate(() => {
                 let t, p, i;
                 // Título
                 t = document.querySelector('h1.goods-name__txt')?.innerText || document.title;
                 // Preço
                 p = document.querySelector('.product-intro__head-price .discount')?.innerText || 
                     document.querySelector('.product-intro__head-price .original')?.innerText;
                 // Imagem
                 i = document.querySelector('.crop-image-container img')?.src;
                 return { t, p, i };
             });
             if (!title) title = domData.t;
             if (!price) price = domData.p;
             if (!image) image = domData.i;
          }

          // Limpeza final do Título
          if (title) {
              title = title.split('|')[0].split('- SHEIN')[0].trim();
              // Decode HTML entities simples se houver
              title = title.replace(/&amp;/g, '&');
          }

          await browser.close();

          return {
              success: true,
              url: finalUrl,
              monetized_url: monetizedUrl,
              title: title || 'Produto Shein',
              price: price || '',
              image: image || ''
          };
      }

      // ------------------ OUTROS SITES (LÓGICA PADRÃO) ------------------

      const data = await page.evaluate(() => {
        let res = { title: '', price: '', image: '' };
        const hostname = window.location.hostname;

        // ALIEXPRESS
        if (hostname.includes('aliexpress')) {
            const h1 = document.querySelector('h1[data-pl="product-title"], .product-title-text');
            if (h1) res.title = h1.innerText;
            const priceEl = document.querySelector('.product-price-value, .current-price-text');
            if (priceEl) res.price = priceEl.innerText;
        }
        // AMAZON
        else if (hostname.includes('amazon')) {
             const titleEl = document.getElementById('productTitle');
             if (titleEl) res.title = titleEl.innerText;
             const priceEl = document.querySelector('.a-price .a-offscreen');
             if (priceEl) res.price = priceEl.innerText;
             const imgEl = document.getElementById('landingImage');
             if (imgEl) res.image = imgEl.src;
        }

        // JSON-LD FALLBACK
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.innerText);
                const entities = Array.isArray(json) ? json : (json['@graph'] || [json]);
                for (const entity of entities) {
                    if (entity['@type'] === 'Product' || entity['@type'] === 'ProductGroup') {
                        if (!res.title && entity.name) res.title = entity.name;
                        if (!res.image && entity.image) {
                            res.image = Array.isArray(entity.image) ? entity.image[0] : entity.image;
                            if (typeof res.image === 'object' && res.image.url) res.image = res.image.url;
                        }
                        if (!res.price && entity.offers) {
                            const offers = Array.isArray(entity.offers) ? entity.offers : [entity.offers];
                            const offer = offers.find(o => o.price) || offers[0];
                            if (offer && offer.price) {
                                const currency = offer.priceCurrency || 'BRL';
                                res.price = `${currency === 'BRL' ? 'R$' : currency} ${offer.price}`;
                            }
                        }
                    }
                }
            } catch(e) {}
        }

        // META TAGS FALLBACK
        if (!res.title) res.title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title;
        if (!res.image) res.image = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
        if (!res.price) {
            const ogPrice = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content');
            const ogCurrency = document.querySelector('meta[property="product:price:currency"]')?.getAttribute('content');
            if (ogPrice) res.price = (ogCurrency || 'R$') + ' ' + ogPrice;
        }

        if (res.title) {
            const storeSuffixes = [' | Mercado Livre', ' - Mercado Livre', ' | Amazon', ' - Magalu', ' | Magazine Luiza', ' | Shopee', ' | AliExpress'];
            storeSuffixes.forEach(s => res.title = res.title.split(s)[0]);
            res.title = res.title.trim();
        }
        
        // Fix protocol relative URLs
        if (res.image && res.image.startsWith('//')) {
             res.image = 'https:' + res.image;
        }

        return res;
      });

      await browser.close();

      let formattedPrice = data.price;
      if (formattedPrice) {
          formattedPrice = String(formattedPrice).replace(/\s+/g, ' ').replace('R$', '').trim();
          if (!formattedPrice.includes('$') && !formattedPrice.match(/[A-Z]{3}/)) {
             formattedPrice = `R$ ${formattedPrice}`;
          }
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

app.get("/healthz", (req, res) => res.json({ ok: true }));

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
