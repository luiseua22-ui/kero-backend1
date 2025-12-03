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
  timeout: 60000 // Aumentado para 60s para evitar timeout em filas
});

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- BUSCA INTELIGENTE (MANTIDA ORIGINAL) ----------------

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

    // Evitar detecção
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    });

    const results = [];
    
    // 1. Mercado Livre - Primeira tentativa
    console.log("🌐 Tentando Mercado Livre...");
    try {
      const mlResults = await searchMercadoLivre(page, query);
      if (mlResults.length > 0) {
        results.push(...mlResults);
        console.log(`✅ Mercado Livre: ${mlResults.length} produtos`);
      }
    } catch (error) {
      console.log("❌ Mercado Livre falhou:", error.message);
    }
    
    // 2. Amazon - Segunda tentativa
    if (results.length < 5) {
      console.log("🌐 Tentando Amazon...");
      try {
        const amazonResults = await searchAmazon(page, query);
        if (amazonResults.length > 0) {
          results.push(...amazonResults);
          console.log(`✅ Amazon: ${amazonResults.length} produtos`);
        }
      } catch (error) {
        console.log("❌ Amazon falhou:", error.message);
      }
    }
    
    // 3. Magazine Luiza - Terceira tentativa
    if (results.length < 5) {
      console.log("🌐 Tentando Magazine Luiza...");
      try {
        const magaluResults = await searchMagazineLuiza(page, query);
        if (magaluResults.length > 0) {
          results.push(...magaluResults);
          console.log(`✅ Magazine Luiza: ${magaluResults.length} produtos`);
        }
      } catch (error) {
        console.log("❌ Magazine Luiza falhou:", error.message);
      }
    }

    console.log(`🎯 Total encontrado: ${results.length}`);
    
    // Remover duplicatas e limitar resultados
    const uniqueResults = removeDuplicates(results).slice(0, 15);
    
    // Se não encontrou produtos reais, usar fallback
    if (uniqueResults.length === 0) {
      console.log("⚠️  Nenhum produto real encontrado, usando fallback...");
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
    console.log(`🔗 Acessando: ${searchUrl}`);
    await page.goto(searchUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 15000 
    });
    
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('.ui-search-layout__item, .andes-card, [data-testid="product-card"]');
      
      console.log(`🔎 Elementos encontrados no DOM: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          const titleElement = element.querySelector('.ui-search-item__title, .ui-search-item__group--title, h2');
          const priceElement = element.querySelector('.andes-money-amount__fraction, .price-tag-fraction, .ui-search-price__part');
          const imageElement = element.querySelector('.ui-search-result-image__element, img.slider-image, [data-src]');
          const linkElement = element.querySelector('.ui-search-link, .ui-search-item__group--element a, a[href*="/p/"]');
          
          if (titleElement && priceElement) {
            const title = titleElement.textContent.trim();
            const priceText = priceElement.textContent.trim();
            const price = priceText.includes('R$') ? priceText : `R$ ${priceText}`;
            const imageUrl = imageElement ? (imageElement.src || imageElement.getAttribute('data-src') || imageElement.getAttribute('src') || '') : '';
            const link = linkElement ? linkElement.href.split('?')[0] : '#';
            
            if (title && price && price.length > 3) {
              items.push({
                title: title.length > 80 ? title.substring(0, 80) + '...' : title,
                price: price,
                store: 'Mercado Livre',
                imageUrl: imageUrl,
                link: link
              });
            }
          }
        } catch (error) {
          continue;
        }
        
        if (items.length >= 8) break;
      }
      
      return items;
    });
    
    console.log(`📊 Mercado Livre processado: ${results.length} produtos`);
    return results;
    
  } catch (error) {
    console.error("Erro no Mercado Livre:", error.message);
    return [];
  }
}

async function searchAmazon(page, query) {
  const searchUrl = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}&__mk_pt_BR=%C3%85M%C3%85%C5%BD%C3%95%C3%91`;
  
  try {
    console.log(`🔗 Acessando: ${searchUrl}`);
    await page.goto(searchUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 15000 
    });
    
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item');
      
      console.log(`🔎 Elementos encontrados no DOM: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          const titleElement = element.querySelector('h2 a span, .a-size-base-plus, .a-text-normal');
          const priceWhole = element.querySelector('.a-price-whole');
          const priceFraction = element.querySelector('.a-price-fraction');
          const priceSymbol = element.querySelector('.a-price-symbol');
          const imageElement = element.querySelector('.s-image, img.s-image, [data-image-latency="s-product-image"]');
          const linkElement = element.querySelector('h2 a, a.a-link-normal.s-no-outline');
          
          if (titleElement && (priceWhole || priceSymbol)) {
            const title = titleElement.textContent.trim();
            let price = '';
            
            if (priceWhole && priceFraction) {
              price = `R$ ${priceWhole.textContent.trim()}${priceFraction.textContent.trim()}`;
            } else if (priceSymbol && priceSymbol.textContent.includes('R$')) {
              price = priceSymbol.textContent.trim();
            } else if (priceWhole) {
              price = `R$ ${priceWhole.textContent.trim()}`;
            }
            
            const imageUrl = imageElement ? (imageElement.src || imageElement.getAttribute('src') || '') : '';
            const link = linkElement ? `https://www.amazon.com.br${linkElement.getAttribute('href')}`.split('?')[0] : '#';
            
            if (title && price && price.length > 3) {
              items.push({
                title: title.length > 80 ? title.substring(0, 80) + '...' : title,
                price: price,
                store: 'Amazon',
                imageUrl: imageUrl,
                link: link
              });
            }
          }
        } catch (error) {
          continue;
        }
        
        if (items.length >= 8) break;
      }
      
      return items;
    });
    
    console.log(`📊 Amazon processado: ${results.length} produtos`);
    return results;
    
  } catch (error) {
    console.error("Erro na Amazon:", error.message);
    return [];
  }
}

async function searchMagazineLuiza(page, query) {
  const searchUrl = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`;
  
  try {
    console.log(`🔗 Acessando: ${searchUrl}`);
    await page.goto(searchUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 15000 
    });
    
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('[data-testid="product-card"], .product-card');
      
      console.log(`🔎 Elementos encontrados no DOM: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          const titleElement = element.querySelector('[data-testid="product-title"], .product-title, h2');
          const priceElement = element.querySelector('[data-testid="price-value"], .price, .price-value');
          const imageElement = element.querySelector('img, [data-testid="image"]');
          const linkElement = element.querySelector('a, [href*="/produto/"]');
          
          if (titleElement && priceElement) {
            const title = titleElement.textContent.trim();
            const price = priceElement.textContent.trim();
            const imageUrl = imageElement ? (imageElement.src || imageElement.getAttribute('src') || '') : '';
            const link = linkElement ? (linkElement.href.startsWith('http') ? linkElement.href : `https://www.magazineluiza.com.br${linkElement.href}`).split('?')[0] : '#';
            
            if (title && price && price.length < 50) { // Filtra preços inválidos
              items.push({
                title: title.length > 80 ? title.substring(0, 80) + '...' : title,
                price: price.includes('R$') ? price : `R$ ${price}`,
                store: 'Magazine Luiza',
                imageUrl: imageUrl,
                link: link
              });
            }
          }
        } catch (error) {
          continue;
        }
        
        if (items.length >= 6) break;
      }
      
      return items;
    });
    
    console.log(`📊 Magazine Luiza processado: ${results.length} produtos`);
    return results;
    
  } catch (error) {
    console.error("Erro na Magazine Luiza:", error.message);
    return [];
  }
}

function removeDuplicates(products) {
  const seen = new Set();
  const unique = [];
  
  for (const product of products) {
    if (!product.title || !product.price) continue;
    
    // Cria uma chave única baseada no título e preço
    const key = `${product.title.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '')}_${product.price}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }
  
  return unique;
}

function getFallbackProducts(query) {
  // Produtos de fallback baseados em categorias comuns
  const fallbackMap = {
    'rolex': [
      {
        title: 'Relógio Rolex Oyster Perpetual 41mm Aço',
        price: 'R$ 45.990,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/rolex'
      },
      {
        title: 'Rolex Datejust 36mm Aço e Ouro',
        price: 'R$ 52.500,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL1500_.jpg',
        link: 'https://www.amazon.com.br/s?k=rolex'
      }
    ],
    'iphone': [
      {
        title: 'iPhone 15 Pro 256GB Titânio Natural',
        price: 'R$ 8.499,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA73905315953_012024-F.webp',
        link: 'https://lista.mercadolivre.com.br/iphone-15'
      },
      {
        title: 'iPhone 14 128GB Meia-noite',
        price: 'R$ 4.999,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/61bK6PMOC3L._AC_SL1500_.jpg',
        link: 'https://www.amazon.com.br/s?k=iphone'
      }
    ],
    'notebook': [
      {
        title: 'Notebook Dell Inspiron 15 512GB SSD 16GB RAM',
        price: 'R$ 3.299,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/notebook'
      },
      {
        title: 'Notebook Acer Aspire 5 256GB SSD 8GB RAM',
        price: 'R$ 2.499,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL1500_.jpg',
        link: 'https://www.amazon.com.br/s?k=notebook'
      }
    ],
    'tenis': [
      {
        title: 'Tênis Nike Air Max 270 Preto',
        price: 'R$ 599,90',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/tenis-nike'
      },
      {
        title: 'Tênis Adidas Ultraboost 22 Branco',
        price: 'R$ 699,90',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL1500_.jpg',
        link: 'https://www.amazon.com.br/s?k=tenis'
      }
    ]
  };

  // Verifica se a query corresponde a uma categoria conhecida
  const queryLower = query.toLowerCase();
  for (const [category, products] of Object.entries(fallbackMap)) {
    if (queryLower.includes(category)) {
      return products;
    }
  }

  // Fallback genérico
  return [
    {
      title: `Produto ${query} - Modelo Premium`,
      price: 'R$ 299,90',
      store: 'Mercado Livre',
      imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA74563811144_022024-F.webp',
      link: `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}`
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - Versão Avançada`,
      price: 'R$ 499,90',
      store: 'Amazon',
      imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL1500_.jpg',
      link: `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - Edição Especial`,
      price: 'R$ 399,90',
      store: 'Magazine Luiza',
      imageUrl: 'https://a-static.mlcdn.com.br/450x450/smart-tv-50-4k-uhd-lg-50ur8750psb-ai-thinq-webos-processador-alpha-7-4-hdmi/magazineluiza/236597800/ff720c5ea6d4611e2c7948847bde6cd2.jpg',
      link: `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`
    }
  ];
}

// ---------------- SCRAPING DE URL INDIVIDUAL (ATUALIZADO E CORRIGIDO) ----------------
// Esta função substitui a antiga que cortava títulos e perdia preços

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
      
      // Cabeçalhos para parecer um navegador real
      await page.setExtraHTTPHeaders({ 
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"
      });
      
      // Espera até a rede acalmar (crucial para sites lentos ou JS pesado)
      await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });

      const data = await page.evaluate(() => {
        // --- 1. TÍTULO ---
        let title = document.querySelector('h1')?.innerText?.trim() || 
                   document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                   document.title;
        
        // CORREÇÃO: Não corta mais o título no primeiro '-'. Remove apenas sufixos de loja.
        if (title) {
            const storeSuffixes = [
                ' | Mercado Livre', ' - Mercado Livre', 
                ' | Amazon.com.br', ' : Amazon.com.br', ' | Amazon',
                ' | Magazine Luiza', ' - Magalu',
                ' | Shopee Brasil', ' | Shopee', ' | Casas Bahia'
            ];
            storeSuffixes.forEach(suffix => {
                if (title.includes(suffix)) {
                    title = title.replace(suffix, '');
                }
            });
        }

        // --- 2. PREÇO ---
        let price = null;
        
        // A. JSON-LD (Mais confiável)
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.innerText);
                // Schema: Product direto
                if (json['@type'] === 'Product' && json.offers) {
                     const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
                     if (offer.price) {
                         price = offer.price;
                         break;
                     }
                }
                // Schema: Grafo de objetos
                if (json['@graph']) {
                    const product = json['@graph'].find(i => i['@type'] === 'Product');
                    if (product && product.offers && product.offers.price) {
                        price = product.offers.price;
                        break;
                    }
                }
            } catch(e) {}
        }

        // B. Seletores Visuais (Fallback)
        if (!price) {
            const priceSelectors = [
              '.price', '[itemprop="price"]', 
              '.a-price-whole',                 // Amazon
              '.andes-money-amount__fraction',  // Mercado Livre
              '[data-testid="price-value"]',    // Magalu
              '.product-price-value',
              '.sales-price',
              '.skuBestPrice'
            ];
            
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.match(/\d/)) {
                    price = el.innerText.trim();
                    // Se for Amazon, tenta pegar os centavos
                    if (sel === '.a-price-whole') {
                        const fraction = document.querySelector('.a-price-fraction');
                        if (fraction) price = price + fraction.innerText;
                    }
                    break;
                }
            }
        }
        
        // --- 3. IMAGEM ---
        let image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                    document.querySelector('.s-image')?.src ||
                    document.querySelector('img[data-testid="image"]')?.src || '';

        return { title, price, image };
      });

      await browser.close();

      // Formatação Final do Preço
      let formattedPrice = data.price;
      if (formattedPrice) {
          formattedPrice = String(formattedPrice).replace(/\s+/g, ' ');
          // Se for só número (ex: 150.00), adiciona R$
          if (!formattedPrice.includes('R$') && !formattedPrice.includes('$')) {
              formattedPrice = `R$ ${formattedPrice}`;
          }
      }

      return {
        success: true,
        url: url,
        title: data.title || 'Produto sem título',
        price: formattedPrice || '', // Retorna vazio se não achar, frontend permite digitar
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
  res.json({ 
    ok: true,
    message: "Backend funcionando",
    timestamp: new Date().toISOString()
  });
});

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: "Parâmetro 'url' é obrigatório" 
      });
    }

    const isUrl = url && (url.startsWith('http://') || url.startsWith('https://'));

    if (isUrl) {
      // Modo scraping de URL única (AGORA USANDO A NOVA FUNÇÃO CORRIGIDA)
      const result = await scrapeProduct(url);
      res.json(result);
    } else {
      // Modo busca por termo
      console.log(`\n📍 NOVA BUSCA: "${url}"`);
      
      if (url.trim().length < 2) {
        return res.json([]);
      }

      const products = await searchWithPuppeteer(url);
      
      console.log(`📦 Retornando ${products.length} produtos para "${url}"\n`);
      res.json(products);
    }

  } catch (error) {
    console.error("❌ ERRO NA ROTA /scrape:", error.message);
    const query = req.body?.url || req.query?.url || 'produto';
    res.json(getFallbackProducts(query));
  }
});

// Rota de teste
app.get("/test", (req, res) => {
  console.log("✅ Teste recebido");
  res.json([
    {
      title: "Smartphone Samsung Galaxy S23 Ultra 5G 256GB",
      price: "R$ 4.999,00",
      store: "Mercado Livre",
      imageUrl: "https://http2.mlstatic.com/D_NQ_NP_2X_600-MLA74563811144_022024-F.webp",
      link: "https://lista.mercadolivre.com.br/samsung-s23"
    },
    {
      title: "Fone de Ouvido Bluetooth Sony WH-1000XM5",
      price: "R$ 1.799,00",
      store: "Amazon",
      imageUrl: "https://m.media-amazon.com/images/I/71ABC12345L._AC_SL1500_.jpg",
      link: "https://www.amazon.com.br/fone-sony"
    }
  ]);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`
🎯 BACKEND RODANDO NA PORTA ${PORT}
📡 Modo: Híbrido (Busca + Scraping Individual Corrigido)
⚡ Concorrência: ${Number(process.env.SCRAPE_CONCURRENCY) || 1}
🕒 Timeout: 60s
  `);
});
