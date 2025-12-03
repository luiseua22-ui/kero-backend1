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

// Concurrency limited to 1 for free tier stability
const queue = new PQueue({ 
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 1,
  timeout: 60000 // Increased timeout for queue
});

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- BUSCA INTELIGENTE (SEARCH) ----------------
// (Used when searching for terms like "iphone")

async function searchWithPuppeteer(query) {
  console.log(`🔍 Buscando: "${query}"`);
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=site-per-process",
      "--window-size=1280,800",
      "--disable-blink-features=AutomationControlled"
    ],
  });

  const page = await browser.newPage();
  
  try {
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setExtraHTTPHeaders({
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
    });

    const results = [];
    
    // 1. Mercado Livre
    console.log("🌐 Tentando Mercado Livre...");
    try {
      const mlResults = await searchMercadoLivre(page, query);
      if (mlResults.length > 0) {
        results.push(...mlResults);
      }
    } catch (error) {
      console.log("❌ Mercado Livre falhou:", error.message);
    }
    
    // 2. Amazon (If needed)
    if (results.length < 5) {
      console.log("🌐 Tentando Amazon...");
      try {
        const amazonResults = await searchAmazon(page, query);
        if (amazonResults.length > 0) {
          results.push(...amazonResults);
        }
      } catch (error) {
        console.log("❌ Amazon falhou:", error.message);
      }
    }
    
    // 3. Magazine Luiza (If needed)
    if (results.length < 5) {
      console.log("🌐 Tentando Magazine Luiza...");
      try {
        const magaluResults = await searchMagazineLuiza(page, query);
        if (magaluResults.length > 0) {
          results.push(...magaluResults);
        }
      } catch (error) {
        console.log("❌ Magazine Luiza falhou:", error.message);
      }
    }

    console.log(`🎯 Total encontrado: ${results.length}`);
    
    const uniqueResults = removeDuplicates(results).slice(0, 15);
    
    if (uniqueResults.length === 0) {
      return getFallbackProducts(query);
    }
    
    return uniqueResults;

  } catch (error) {
    console.error("❌ Erro geral na busca:", error);
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

async function searchMagazineLuiza(page, query) {
  const searchUrl = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    return await page.evaluate(() => {
      const items = [];
      const elements = document.querySelectorAll('[data-testid="product-card"]');
      for (const el of elements) {
        try {
          const title = el.querySelector('[data-testid="product-title"]')?.textContent.trim();
          const price = el.querySelector('[data-testid="price-value"]')?.textContent.trim();
          const image = el.querySelector('img')?.src;
          const link = el.querySelector('a')?.href;
          if (title && price && link) {
            items.push({ title, price, store: 'Magazine Luiza', imageUrl: image, link });
          }
        } catch(e) {}
        if (items.length >= 6) break;
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
  return [
    {
      title: `${query} (Resultado Genérico)`,
      price: 'R$ 0,00',
      store: 'Web',
      imageUrl: '',
      link: `https://www.google.com/search?q=${query}`
    }
  ];
}

// ---------------- SCRAPING INDIVIDUAL (CORRIGIDO) ----------------
// (Used when adding a specific link)

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL individual (Improved):", rawUrl);
    
    let browser = null;
    try {
      if (!rawUrl || typeof rawUrl !== 'string') {
        return { success: false, error: "URL inválida" };
      }

      let url = rawUrl.trim();
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }

      browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox", 
          "--disable-setuid-sandbox", 
          "--window-size=1920,1080",
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ]
      });

      const page = await browser.newPage();
      
      // Set extra headers to look like a real browser
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"
      });
      
      // Wait for network idle to ensure JS loaded prices appear
      // Timeout increased to 25s for slow sites
      await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

      const data = await page.evaluate(() => {
        // --- 1. TITLE EXTRACTION ---
        // Prioritize H1, then OG Meta, then Title
        let title = document.querySelector('h1')?.innerText?.trim() || 
                   document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                   document.title;
        
        // CORRECTION: Do not blindly split by '-'. Only remove specific store suffixes.
        if (title) {
            const storeSuffixes = [
                ' | Mercado Livre', ' - Mercado Livre', 
                ' | Amazon.com.br', ' : Amazon.com.br', ' | Amazon',
                ' | Magazine Luiza', ' - Magalu',
                ' | Shopee Brasil', ' | Shopee'
            ];
            storeSuffixes.forEach(suffix => {
                if (title.includes(suffix)) {
                    title = title.replace(suffix, '');
                }
            });
        }

        // --- 2. PRICE EXTRACTION (Robust) ---
        let price = null;
        
        // A. JSON-LD (Best for SEO-heavy sites like Amazon, Magalu)
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.innerText);
                // Schema: Product
                if (json['@type'] === 'Product' && json.offers) {
                     const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
                     if (offer.price) {
                         price = offer.price;
                         break;
                     }
                }
                // Schema: Offers inside graph
                if (json['@graph']) {
                    const product = json['@graph'].find(i => i['@type'] === 'Product');
                    if (product && product.offers && product.offers.price) {
                        price = product.offers.price;
                        break;
                    }
                }
            } catch(e) {}
        }

        // B. Visual Selectors (Fallback)
        if (!price) {
            const priceSelectors = [
              '.price', '[itemprop="price"]', 
              '.a-price-whole',                 // Amazon
              '.andes-money-amount__fraction',  // Mercado Livre
              '[data-testid="price-value"]',    // Magalu
              '.product-price-value',
              '.sales-price'
            ];
            
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.match(/\d/)) {
                    price = el.innerText.trim();
                    // If Amazon, check for fraction
                    if (sel === '.a-price-whole') {
                        const fraction = document.querySelector('.a-price-fraction');
                        if (fraction) price = price + fraction.innerText;
                    }
                    break;
                }
            }
        }
        
        // --- 3. IMAGE EXTRACTION ---
        let image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    document.querySelector('.s-image')?.src ||
                    document.querySelector('img[data-testid="image"]')?.src || '';

        return { title, price, image };
      });

      await browser.close();

      // Format Price
      let formattedPrice = data.price;
      if (formattedPrice) {
          formattedPrice = String(formattedPrice).replace(/\s+/g, ' ');
          if (!formattedPrice.includes('R$') && !formattedPrice.includes('$')) {
              formattedPrice = `R$ ${formattedPrice}`;
          }
      }

      return {
        success: true,
        url: url,
        title: data.title || 'Produto sem título',
        price: formattedPrice || '', // Returns empty string if not found, allowing frontend manual entry
        image: data.image || ''
      };

    } catch (error) {
      console.error("❌ Erro no scraping individual:", error.message);
      if (browser) await browser.close();
      return {
        success: false,
        url: rawUrl,
        error: "Não foi possível obter informações do produto"
      };
    }
  });
}

// ---------------- ROTAS ----------------

app.get("/healthz", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    
    if (!url) {
      return res.status(400).json({ success: false, error: "URL obrigatória" });
    }

    const isUrl = url.trim().match(/^(http|www\.)/);

    if (isUrl) {
      // SCRAPING INDIVIDUAL
      const result = await scrapeProduct(url);
      res.json(result);
    } else {
      // BUSCA
      if (url.trim().length < 2) return res.json([]);
      const products = await searchWithPuppeteer(url);
      res.json(products);
    }

  } catch (error) {
    console.error("❌ Erro rota /scrape:", error);
    res.json(getFallbackProducts(req.body?.url || ''));
  }
});

app.get("/test", (req, res) => {
  res.json([{ title: "Teste Backend OK", price: "R$ 1,00", store: "KERO" }]);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🎯 Backend KERO rodando na porta ${PORT}`);
});
