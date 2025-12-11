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

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

const queue = new PQueue({ 
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 1,
  timeout: 60000 
});

// User Agent de alta confiança (Mac/Chrome)
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------------- SISTEMA DE AFILIADOS (MONETIZAÇÃO) ----------------

/**
 * Função para aplicar tags de afiliado na URL.
 * Suporta Amazon e Mercado Livre.
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

    const domain = urlObj.hostname.replace('www.', '');
    
    // --- 1. AMAZON (Tag: kero0a-20) ---
    if (domain.includes('amazon.')) {
      // Remove tags de concorrentes
      urlObj.searchParams.delete('tag'); 
      urlObj.searchParams.delete('ascsubtag');
      urlObj.searchParams.delete('linkCode');
      urlObj.searchParams.delete('ref'); // Limpa referências sujas
      
      // Aplica SUAS tags
      urlObj.searchParams.set('tag', 'kero0a-20');
      return urlObj.toString();
    }

    // --- 2. MERCADO LIVRE (Etiqueta: lo20251209171148) ---
    if (domain.includes('mercadolivre.com.br') || domain.includes('mercadolibre.')) {
       // IDs fornecidos
       // matt_tool=57996476
       // matt_word=lo20251209171148

       // Remove tags de concorrentes ou antigas
       urlObj.searchParams.delete('matt_tool');
       urlObj.searchParams.delete('matt_word');
       urlObj.searchParams.delete('click_id');
       urlObj.searchParams.delete('af_click_lookback');
       
       // Aplica SUAS tags
       urlObj.searchParams.set('matt_tool', '57996476');
       urlObj.searchParams.set('matt_word', 'lo20251209171148');
       
       return urlObj.toString();
    }

    // Retorna original para outros sites
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
    
    // 2. Amazon (se precisar)
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

// ---------------- SCRAPING INDIVIDUAL (CORRIGIDO PARA MORANA E OUTROS) ----------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL:", rawUrl);
    
    let browser = null;
    try {
      if (!rawUrl || typeof rawUrl !== 'string') return { success: false, error: "URL inválida" };

      let url = rawUrl.trim();
      if (!url.startsWith('http')) url = 'https://' + url;

      // Monetização inicial (pré-navegação) - útil se o puppeteer falhar
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
      
      // HEADERS ROBUSTOS
      await page.setUserAgent(DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1"
      });
      
      // Navega para a URL
      await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

      // --- CRÍTICO: CAPTURA URL FINAL APÓS REDIRECIONAMENTOS ---
      // Se o usuário colou amzn.to ou meli.la, agora temos a URL real do produto
      const finalUrl = page.url();
      
      // Regera o link monetizado baseado na URL final limpa e resolvida
      // Isso garante que sobrescrevemos tags de concorrentes escondidas em links curtos
      monetizedUrl = generateAffiliateLink(finalUrl);

      const data = await page.evaluate(() => {
        // --- TÍTULO ---
        let title = document.querySelector('h1')?.innerText?.trim() || 
                   document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                   document.title;
        
        // Remove sufixos comuns
        if (title) {
            const storeSuffixes = [' | Mercado Livre', ' - Mercado Livre', ' | Amazon', ' - Magalu', ' | Magazine Luiza', ' | Shopee', ' | Morana'];
            storeSuffixes.forEach(s => title = title.split(s)[0]);
        }

        // --- PREÇO (LÓGICA BLINDADA ANTI-FRETE) ---
        let price = null;
        
        // 0. Meta Tags
        const metaPrice = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') ||
                          document.querySelector('meta[property="og:price:amount"]')?.getAttribute('content');
        if (metaPrice && metaPrice.match(/\d/)) {
            price = metaPrice;
        }

        // 1. JSON-LD
        if (!price) {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                try {
                    const json = JSON.parse(script.innerText);
                    if (json['@type'] === 'Product' && json.offers) {
                        const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
                        if (offer.price) { price = offer.price; break; }
                        if (offer.lowPrice) { price = offer.lowPrice; break; }
                    }
                    if (json['@graph']) {
                        const p = json['@graph'].find(i => i['@type'] === 'Product');
                        if (p?.offers?.price) { price = p.offers.price; break; }
                    }
                } catch(e) {}
            }
        }

        // 2. Seletores Visuais
        if (!price) {
            const priceSelectors = [
              '.skuBestPrice',                // VTEX (Morana)
              '.best-price',
              '.val-best-price',
              '.product-price', 
              '.price', 
              '[itemprop="price"]', 
              '.a-price-whole',               // Amazon
              '.andes-money-amount__fraction',// Mercado Livre
              '[data-testid="price-value"]',  // Magalu
              '.sales-price',
              '.current-price'
            ];
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
        
        // 3. REGEX
        if (!price) {
           const mainContent = document.querySelector('main') || 
                               document.querySelector('.product-container') || 
                               document.querySelector('#product-content') || 
                               document.querySelector('.vtex-store-components-3-x-productContainer') || 
                               document.body; 
           
           const bodyText = mainContent.innerText;
           const match = bodyText.match(/R\$\s?(\d{1,3}(\.?\d{3})*,\d{2})/);
           if (match) price = match[0];
        }

        // --- IMAGEM ---
        let image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    document.querySelector('.s-image')?.src ||
                    document.querySelector('img[data-testid="image"]')?.src || 
                    document.querySelector('#image-main')?.src || '';

        return { title, price, image };
      });

      await browser.close();

      // Limpeza do preço
      let formattedPrice = data.price;
      if (formattedPrice) {
          formattedPrice = String(formattedPrice).replace(/\s+/g, ' ').replace('R$', '').trim();
          formattedPrice = `R$ ${formattedPrice}`;
      }

      return {
        success: true,
        url: finalUrl, // Retorna a URL final resolvida
        monetized_url: monetizedUrl, // Retorna o link monetizado (que usa a URL final)
        title: data.title || 'Produto',
        price: formattedPrice || '', 
        image: data.image || ''
      };

    } catch (error) {
      console.error("Scrape Error:", error.message);
      if (browser) await browser.close();
      return { success: false, url: rawUrl, error: "Erro ao ler site" };
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
    res.json(getFallbackProducts(req.body?.url || ''));
  }
});

app.get("/test", (req, res) => {
  res.json([{ title: "Teste Backend OK", price: "R$ 1,00", store: "KERO" }]);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🎯 Backend rodando na porta ${PORT}`));
