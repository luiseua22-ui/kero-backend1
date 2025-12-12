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

const queue = new PQueue({ 
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 1,
  timeout: 60000 
});

// User Agent de alta confiança (Mac/Chrome)
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------------- SISTEMA DE AFILIADOS (MONETIZAÇÃO BLINDADA) ----------------

/**
 * ROTA DE DEEP LINK E REDIRECIONAMENTO SEGURO
 * 
 * Para Mercado Livre: Usa "Cookie Drop" via Iframe (Atribuição Social).
 * Para Amazon: Usa HTTP 302 Redirect (Atribuição Técnica via Server-Side).
 */
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

  // --- ESTRATÉGIA AMAZON (LAYER 1 & 2: CONSTRUÇÃO + 302 REDIRECT) ---
  if (domain.includes("amazon")) {
      try {
          const urlObj = new URL(targetUrl);
          
          // 1. LIMPEZA TOTAL (Remove tags de concorrentes e lixo)
          const paramsToRemove = [
              'tag', 'ascsubtag', 'linkCode', 'ref', 'ref_', 'pf_rd_r', 'pf_rd_p', 
              'pf_rd_m', 'pf_rd_s', 'pf_rd_t', 'scm', 'sr', 'qid', 'keywords'
          ];
          paramsToRemove.forEach(p => urlObj.searchParams.delete(p));

          // 2. INJEÇÃO DA SUA TAG
          urlObj.searchParams.set('tag', 'kero0a-20');

          // 3. INJEÇÃO DE SUBTAG DE RASTREAMENTO (Unique Click ID)
          // Formato: kero_timestamp_random
          const uniqueClickId = `kero_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          urlObj.searchParams.set('ascsubtag', uniqueClickId);

          // 4. REDIRECIONAMENTO 302 (Muda a URL no navegador mantendo a atribuição)
          return res.redirect(302, urlObj.toString());

      } catch (e) {
          console.error("Erro ao processar link Amazon:", e);
          return res.redirect(targetUrl); // Fallback
      }
  }

  // --- ESTRATÉGIA MERCADO LIVRE (COOKIE DROP) ---
  if (domain.includes("mercadolivre") || domain.includes("mercadolibre")) {
      const ML_TAG = "lo20251209171148";
      const MATT_TOOL = "57996476";

      // Link social para gravar cookie
      const socialUrl = `https://www.mercadolivre.com.br/social/${ML_TAG}?matt_word=${ML_TAG}&matt_tool=${MATT_TOOL}`;

      // Link final do produto com reforço de parâmetros
      let finalProductUrl = targetUrl;
      try {
          const urlObj = new URL(targetUrl);
          // Remove tracking sujo
          ['click_id', 'wid', 'sid', 'c_id', 'c_uid', 'reco_id', 'reco_backend'].forEach(p => urlObj.searchParams.delete(p));
          // Reforço
          urlObj.searchParams.set('matt_tool', MATT_TOOL);
          urlObj.searchParams.set('matt_word', ML_TAG);
          finalProductUrl = urlObj.toString();
      } catch(e) {}

      // Página Sanduíche
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
                setTimeout(function() { window.location.replace("${finalProductUrl}"); }, 1000);
            </script>
        </body>
        </html>
      `;
      return res.send(html);
  }

  // Fallback padrão para outros domínios
  return res.redirect(targetUrl);
});


/**
 * Gerador de Links
 * Agora força TODOS os links de Amazon e Mercado Livre a passarem pelo 
 * nosso proxy (/deep-link) para garantir a aplicação da Camada 2.
 */
function generateAffiliateLink(urlInput) {
  if (!urlInput) return urlInput;
  
  try {
    let urlObj;
    try {
        urlObj = new URL(urlInput);
    } catch (e) {
        return urlInput;
    }

    // Proteção contra loops ou páginas de sistema
    if (urlObj.href.includes('/gz/account-verification') || 
        urlObj.href.includes('/suspendida') || 
        urlObj.href.includes('/login')) {
        return urlInput;
    }

    const domain = urlObj.hostname;
    
    // Se for Amazon ou ML, gera o link proxy
    if (domain.includes('amazon') || domain.includes('mercadolivre') || domain.includes('mercadolibre')) {
       const targetUrlEncoded = encodeURIComponent(urlInput);
       return `${BASE_URL}/deep-link?url=${targetUrlEncoded}`;
    }

    return urlInput;

  } catch (error) {
    console.error("Erro ao gerar link afiliado:", error);
    return urlInput;
  }
}

// ---------------- BUSCA INTELIGENTE (SEARCH) ----------------

async function searchWithPuppeteer(query) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,768"
    ],
  });

  const page = await browser.newPage();
  
  try {
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      "sec-ch-ua-platform": '"macOS"',
      "Upgrade-Insecure-Requests": "1"
    });

    const results = [];
    
    // 1. Mercado Livre
    try {
      const mlResults = await searchMercadoLivre(page, query);
      if (mlResults.length > 0) results.push(...mlResults);
    } catch (error) {}
    
    // 2. Amazon
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

// ---------------- SCRAPING INDIVIDUAL (CORRIGIDO PARA AMAZON E OUTROS) ----------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL:", rawUrl);
    
    let browser = null;
    try {
      if (!rawUrl || typeof rawUrl !== 'string') return { success: false, error: "URL inválida" };

      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;

      // Gera o link seguro (deep-link) imediatamente
      let monetizedUrl = generateAffiliateLink(url);

      browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox", 
          "--disable-setuid-sandbox", 
          "--window-size=1920,1080"
        ]
      });

      const page = await browser.newPage();
      
      await page.setUserAgent(DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1"
      });
      
      await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

      // --- CORREÇÃO DE URL BLOQUEADA / REDIRECIONADA ---
      const pageUrl = page.url();
      let finalUrl = pageUrl;

      // Verifica bloqueio do ML
      if (pageUrl.includes('/gz/account-verification') || 
          pageUrl.includes('/login') || 
          pageUrl.includes('/suspendida')) {
          
          try {
              const urlObj = new URL(pageUrl);
              const goParam = urlObj.searchParams.get('go');
              if (goParam) {
                  finalUrl = decodeURIComponent(goParam);
              } else {
                  finalUrl = url;
              }
          } catch (e) {
              finalUrl = url;
          }
      } else {
          // Se não foi bloqueado, usamos a URL resolvida (útil para links encurtados da Amazon amzn.to -> amazon.com.br)
          finalUrl = pageUrl;
      }

      // Se a URL final mudou, regeramos o link monetizado
      if (finalUrl !== url) {
          monetizedUrl = generateAffiliateLink(finalUrl);
      }

      const data = await page.evaluate(() => {
        let title = '';
        let price = null;
        let image = '';

        // 1. TENTATIVA VIA JSON-LD (DADOS ESTRUTURADOS) - MAIS CONFIÁVEL PARA AMAZON
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.innerText);
                
                // Formato padrão Product
                if (json['@type'] === 'Product') {
                    if (json.name) title = json.name;
                    if (json.image) {
                        image = Array.isArray(json.image) ? json.image[0] : json.image;
                    }
                    if (json.offers) {
                        const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
                        if (offer.price) price = offer.price;
                        if (offer.lowPrice) price = offer.lowPrice;
                    }
                }
                
                // Formato Graph
                if (json['@graph']) {
                    const p = json['@graph'].find(i => i['@type'] === 'Product');
                    if (p) {
                        if (p.name) title = p.name;
                        if (p.image) image = p.image;
                        if (p.offers && p.offers.price) price = p.offers.price;
                    }
                }
                
                // Se achou tudo, para.
                if (title && price && image) break;
            } catch(e) {}
        }

        // 2. SELETORES ESPECÍFICOS AMAZON (Se JSON-LD falhou)
        if (window.location.hostname.includes('amazon')) {
            if (!title) {
                // IDs clássicos da Amazon
                const amzTitle = document.getElementById('productTitle')?.innerText?.trim();
                if (amzTitle) title = amzTitle;
            }

            if (!image) {
                // IDs de imagem da Amazon (LandingImage é o principal, imgBlkFront é livros)
                const amzImg = document.getElementById('landingImage')?.src ||
                               document.getElementById('imgBlkFront')?.src ||
                               document.querySelector('#imgTagWrapperId img')?.src ||
                               document.querySelector('.a-dynamic-image')?.src;
                
                // Tenta pegar do atributo data-a-dynamic-image se existir (JSON dentro de atributo)
                if (!amzImg) {
                    const dynamicContainer = document.getElementById('landingImage') || document.getElementById('imgBlkFront');
                    if (dynamicContainer) {
                        const dataDynamic = dynamicContainer.getAttribute('data-a-dynamic-image');
                        if (dataDynamic) {
                            try {
                                const urls = Object.keys(JSON.parse(dataDynamic));
                                if (urls.length > 0) image = urls[0];
                            } catch(e){}
                        }
                    }
                }

                if (amzImg) image = amzImg;
            }
        }

        // 3. FALLBACK GENÉRICO (OUTROS SITES)
        if (!title) {
            title = document.querySelector('h1')?.innerText?.trim() || 
                    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                    document.title;
        }
        
        // Limpeza de título
        if (title) {
            const storeSuffixes = [' | Mercado Livre', ' - Mercado Livre', ' | Amazon', ' - Magalu', ' | Magazine Luiza', ' | Shopee'];
            storeSuffixes.forEach(s => title = title.split(s)[0]);
            if (title.includes('Mercado Livre') && document.title.length < 20) title = '';
        }

        if (!price) {
            const metaPrice = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') ||
                              document.querySelector('meta[property="og:price:amount"]')?.getAttribute('content');
            if (metaPrice && metaPrice.match(/\d/)) {
                price = metaPrice;
            }
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

        if (!image) {
            image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    document.querySelector('.s-image')?.src ||
                    document.querySelector('img[data-testid="image"]')?.src || '';
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
