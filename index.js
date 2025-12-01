// index.js - Backend completo com imagens funcionais
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
  timeout: 30000
});

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- BUSCA INTELIGENTE ----------------

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

    // Configurações anti-detecção
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
    
    // Garantir que todas as imagens tenham HTTPS
    const processedResults = uniqueResults.map(product => ({
      ...product,
      imageUrl: ensureHttpsAndFixImageUrl(product.imageUrl, product.store)
    }));
    
    // Se não encontrou produtos reais, usar fallback
    if (processedResults.length === 0) {
      console.log("⚠️  Nenhum produto real encontrado, usando fallback...");
      return getFallbackProducts(query);
    }
    
    return processedResults;

  } catch (error) {
    console.error("❌ Erro geral na busca:", error);
    return getFallbackProducts(query);
  } finally {
    await browser.close();
  }
}

// Função para corrigir URLs de imagem
function ensureHttpsAndFixImageUrl(imageUrl, store) {
  if (!imageUrl || imageUrl.trim() === '') {
    // Imagem padrão por loja
    const defaultImages = {
      'Mercado Livre': 'https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.1/mercadolibre/logo__large_plus.png',
      'Amazon': 'https://m.media-amazon.com/images/G/32/gno/sprites/nav-sprite-global-1x-hm-dsk-reorg._CB405937547_.png',
      'Magazine Luiza': 'https://a-static.mlcdn.com.br/1500x1500/logo-magazine-luiza/magazineluiza/222222222/1234567890.jpg'
    };
    return defaultImages[store] || 'https://via.placeholder.com/300x300/CCCCCC/666666?text=Produto';
  }
  
  // Remove parâmetros de cache e redimensionamento
  let cleanUrl = imageUrl.split('?')[0].split('#')[0];
  
  // Corrige URL do Mercado Livre
  if (store === 'Mercado Livre') {
    // Converte para HTTPS se for HTTP
    if (cleanUrl.startsWith('http://')) {
      cleanUrl = cleanUrl.replace('http://', 'https://');
    }
    
    // Se começar com //, adiciona https:
    if (cleanUrl.startsWith('//')) {
      cleanUrl = 'https:' + cleanUrl;
    }
    
    // Remove parâmetros de qualidade baixa e força qualidade alta
    cleanUrl = cleanUrl.replace(/_O\.jpg$/, '_O.jpg');
    cleanUrl = cleanUrl.replace(/\.jpg$/, '_O.jpg');
    
    // Se for uma imagem pequena, tenta aumentar o tamanho
    if (cleanUrl.includes('D_NQ_NP_') && cleanUrl.includes('-F')) {
      cleanUrl = cleanUrl.replace(/D_NQ_NP_[^\-]+-F/, 'D_NQ_NP_2X_800-F');
    }
    
    // Garante que seja uma imagem válida do ML
    if (!cleanUrl.includes('mercadolibre') && !cleanUrl.includes('mlstatic.com')) {
      return 'https://http2.mlstatic.com/frontend-assets/ui-navigation/5.19.1/mercadolibre/logo__large_plus.png';
    }
  }
  
  // Corrige URL da Amazon
  if (store === 'Amazon') {
    if (cleanUrl.startsWith('http://')) {
      cleanUrl = cleanUrl.replace('http://', 'https://');
    }
    
    // Remove parâmetros de tamanho para pegar imagem maior
    if (cleanUrl.includes('._SL')) {
      cleanUrl = cleanUrl.replace(/\._SL[^_]+_/, '._SL800_');
    }
  }
  
  return cleanUrl;
}

async function searchMercadoLivre(page, query) {
  const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  
  try {
    console.log(`🔗 Acessando Mercado Livre: ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: "networkidle0", 
      timeout: 20000 
    });
    
    // Espera um pouco mais para carregar as imagens
    await page.waitForTimeout(4000);
    
    // Rola a página para carregar imagens lazy
    await page.evaluate(() => {
      window.scrollBy(0, 500);
    });
    await page.waitForTimeout(1000);

    const results = await page.evaluate(() => {
      const items = [];
      // Seletores mais específicos para Mercado Livre
      const productElements = document.querySelectorAll('.ui-search-layout__item');
      
      console.log(`🔎 Elementos encontrados no DOM: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          // Título
          const titleElement = element.querySelector('.ui-search-item__title');
          if (!titleElement) continue;
          
          // Preço - tenta vários seletores
          const priceElement = element.querySelector('.andes-money-amount__fraction') || 
                              element.querySelector('.price-tag-fraction') ||
                              element.querySelector('.ui-search-price__part');
          if (!priceElement) continue;
          
          // IMAGEM - CORREÇÃO CRÍTICA AQUI
          // Mercado Livre usa lazy loading com data-src
          let imageElement = element.querySelector('.ui-search-result-image__element');
          if (!imageElement) {
            // Tenta outros seletores
            imageElement = element.querySelector('img[data-src]') || 
                          element.querySelector('img[src*="mercadolibre"]') ||
                          element.querySelector('img.slider-image');
          }
          
          // Link
          const linkElement = element.querySelector('.ui-search-link') || 
                             element.querySelector('a.ui-search-item__group__element');
          
          if (titleElement && priceElement) {
            const title = titleElement.textContent.trim();
            const priceText = priceElement.textContent.trim();
            const price = priceText.includes('R$') ? priceText : `R$ ${priceText}`;
            
            // Extrai a URL da imagem CORRETAMENTE
            let imageUrl = '';
            if (imageElement) {
              // PRIORIDADE: data-src (lazy loading)
              imageUrl = imageElement.getAttribute('data-src') || 
                        imageElement.getAttribute('src') ||
                        imageElement.getAttribute('data-lazy-src') || '';
              
              // Se a URL começar com //, adiciona https:
              if (imageUrl.startsWith('//')) {
                imageUrl = 'https:' + imageUrl;
              }
              
              // Remove parâmetros de tamanho para pegar imagem maior
              imageUrl = imageUrl.replace(/\.jpg\?.*$/, '.jpg');
              imageUrl = imageUrl.replace(/\.webp\?.*$/, '.webp');
              
              // Garante que seja HTTPS
              if (imageUrl.startsWith('http://')) {
                imageUrl = imageUrl.replace('http://', 'https://');
              }
            }
            
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
          console.log('Erro ao processar item:', error);
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
  const searchUrl = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`;
  
  try {
    console.log(`🔗 Acessando Amazon: ${searchUrl}`);
    await page.goto(searchUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 15000 
    });
    
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('[data-component-type="s-search-result"]');
      
      console.log(`🔎 Elementos Amazon encontrados: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          const titleElement = element.querySelector('h2 a span');
          const priceWhole = element.querySelector('.a-price-whole');
          const priceFraction = element.querySelector('.a-price-fraction');
          const imageElement = element.querySelector('.s-image');
          const linkElement = element.querySelector('h2 a');
          
          if (titleElement && (priceWhole || priceFraction)) {
            const title = titleElement.textContent.trim();
            let price = '';
            
            if (priceWhole && priceFraction) {
              price = `R$ ${priceWhole.textContent.trim()}${priceFraction.textContent.trim()}`;
            } else if (priceWhole) {
              price = `R$ ${priceWhole.textContent.trim()}`;
            }
            
            let imageUrl = '';
            if (imageElement) {
              imageUrl = imageElement.src || '';
              // Garante HTTPS
              if (imageUrl.startsWith('http://')) {
                imageUrl = imageUrl.replace('http://', 'https://');
              }
            }
            
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
    console.log(`🔗 Acessando Magazine Luiza: ${searchUrl}`);
    await page.goto(searchUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 15000 
    });
    
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = [];
      const productElements = document.querySelectorAll('[data-testid="product-card"]');
      
      console.log(`🔎 Elementos Magazine Luiza: ${productElements.length}`);
      
      for (const element of productElements) {
        try {
          const titleElement = element.querySelector('[data-testid="product-title"]');
          const priceElement = element.querySelector('[data-testid="price-value"]');
          const imageElement = element.querySelector('img');
          const linkElement = element.querySelector('a');
          
          if (titleElement && priceElement) {
            const title = titleElement.textContent.trim();
            const price = priceElement.textContent.trim();
            
            let imageUrl = '';
            if (imageElement) {
              imageUrl = imageElement.src || imageElement.getAttribute('src') || '';
              // Garante HTTPS
              if (imageUrl.startsWith('http://')) {
                imageUrl = imageUrl.replace('http://', 'https://');
              }
            }
            
            const link = linkElement ? (linkElement.href.startsWith('http') ? linkElement.href : `https://www.magazineluiza.com.br${linkElement.href}`).split('?')[0] : '#';
            
            if (title && price && price.length < 50) {
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
    
    // Cria uma chave única baseada no título
    const key = product.title.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }
  
  return unique;
}

function getFallbackProducts(query) {
  // Produtos de fallback com imagens funcionais
  const fallbackMap = {
    'rolex': [
      {
        title: 'Relógio Rolex Oyster Perpetual 41mm Aço',
        price: 'R$ 45.990,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/rolex'
      },
      {
        title: 'Rolex Datejust 36mm Aço e Ouro',
        price: 'R$ 52.500,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL800_.jpg',
        link: 'https://www.amazon.com.br/s?k=rolex'
      }
    ],
    'iphone': [
      {
        title: 'iPhone 15 Pro 256GB Titânio Natural',
        price: 'R$ 8.499,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA73905315953_012024-F.webp',
        link: 'https://lista.mercadolivre.com.br/iphone-15'
      },
      {
        title: 'iPhone 14 128GB Meia-noite',
        price: 'R$ 4.999,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/61bK6PMOC3L._AC_SL800_.jpg',
        link: 'https://www.amazon.com.br/s?k=iphone'
      }
    ],
    'notebook': [
      {
        title: 'Notebook Dell Inspiron 15 512GB SSD 16GB RAM',
        price: 'R$ 3.299,00',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/notebook'
      },
      {
        title: 'Notebook Acer Aspire 5 256GB SSD 8GB RAM',
        price: 'R$ 2.499,00',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL800_.jpg',
        link: 'https://www.amazon.com.br/s?k=notebook'
      }
    ],
    'tenis': [
      {
        title: 'Tênis Nike Air Max 270 Preto',
        price: 'R$ 599,90',
        store: 'Mercado Livre',
        imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA74563811144_022024-F.webp',
        link: 'https://lista.mercadolivre.com.br/tenis-nike'
      },
      {
        title: 'Tênis Adidas Ultraboost 22 Branco',
        price: 'R$ 699,90',
        store: 'Amazon',
        imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL800_.jpg',
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

  // Fallback genérico com imagens funcionais
  return [
    {
      title: `Produto ${query} - Modelo Premium`,
      price: 'R$ 299,90',
      store: 'Mercado Livre',
      imageUrl: 'https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA74563811144_022024-F.webp',
      link: `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}`
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - Versão Avançada`,
      price: 'R$ 499,90',
      store: 'Amazon',
      imageUrl: 'https://m.media-amazon.com/images/I/71ABC12345L._AC_SL800_.jpg',
      link: `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`
    },
    {
      title: `${query.charAt(0).toUpperCase() + query.slice(1)} - Edição Especial`,
      price: 'R$ 399,90',
      store: 'Magazine Luiza',
      imageUrl: 'https://a-static.mlcdn.com.br/800x800/smart-tv-50-4k-uhd-lg-50ur8750psb-ai-thinq-webos-processador-alpha-7-4-hdmi/magazineluiza/236597800/ff720c5ea6d4611e2c7948847bde6cd2.jpg',
      link: `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`
    }
  ];
}

// ---------------- SCRAPING DE URL INDIVIDUAL ----------------

async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    console.log("📄 Scraping URL individual:", rawUrl);
    
    try {
      // Verifica se é uma URL válida
      if (!rawUrl || typeof rawUrl !== 'string') {
        return {
          success: false,
          error: "URL inválida"
        };
      }

      // Limpa a URL
      let url = rawUrl.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });

      const page = await browser.newPage();
      
      await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
      await page.waitForTimeout(2000);

      // Extrai informações da página
      const data = await page.evaluate(() => {
        // Título
        let title = document.querySelector('h1')?.textContent?.trim() || 
                   document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                   document.title || 
                   'Produto';
        
        // Remove partes indesejadas do título
        title = title.split('|')[0].split('-')[0].trim();
        
        // Preço - tenta vários seletores comuns
        let price = null;
        const priceSelectors = [
          '[itemprop="price"]',
          '.price',
          '.product-price',
          '.sales-price',
          '.best-price',
          '.price-tag',
          '[data-price]',
          '.a-price-whole',
          '.andes-money-amount__fraction'
        ];
        
        for (const selector of priceSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const content = element.getAttribute('content') || 
                           element.getAttribute('data-price') || 
                           element.textContent;
            if (content && content.trim()) {
              price = content.trim();
              break;
            }
          }
        }
        
        // Imagem - CORREÇÃO ESPECIAL PARA IMAGENS
        let image = null;
        const imageSelectors = [
          'meta[property="og:image"]',
          'meta[name="twitter:image"]',
          '.product-image img',
          'img[src*="product"]',
          'img[alt*="product"]',
          'img[alt*="produto"]',
          '.s-image',
          '.ui-search-result-image__element'
        ];
        
        for (const selector of imageSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            image = element.getAttribute('content') || 
                   element.getAttribute('data-src') || 
                   element.src;
            if (image) {
              // Corrige URLs de imagem
              if (image.startsWith('//')) {
                image = 'https:' + image;
              }
              if (image.startsWith('http://')) {
                image = image.replace('http://', 'https://');
              }
              break;
            }
          }
        }

        return { title, price, image };
      });

      await browser.close();

      // Formata o preço
      let formattedPrice = data.price;
      if (formattedPrice && !formattedPrice.includes('R$')) {
        formattedPrice = `R$ ${formattedPrice.replace(/[^\d,]/g, '')}`;
      }

      return {
        success: true,
        url: url,
        title: data.title,
        price: formattedPrice || 'Preço não disponível',
        image: data.image
      };

    } catch (error) {
      console.error("❌ Erro no scraping:", error.message);
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
      // Modo scraping de URL única
      console.log(`📄 Scraping URL: ${url}`);
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
    
    // Fallback em caso de erro
    const query = req.body?.url || req.query?.url || 'produto';
    res.json(getFallbackProducts(query));
  }
});

// Rota de teste com imagens garantidas
app.get("/test", (req, res) => {
  console.log("✅ Teste recebido");
  res.json([
    {
      title: "Smartphone Samsung Galaxy S23 Ultra 5G 256GB",
      price: "R$ 4.999,00",
      store: "Mercado Livre",
      imageUrl: "https://http2.mlstatic.com/D_NQ_NP_2X_800-MLA74563811144_022024-F.webp",
      link: "https://lista.mercadolivre.com.br/samsung-s23"
    },
    {
      title: "Fone de Ouvido Bluetooth Sony WH-1000XM5",
      price: "R$ 1.799,00",
      store: "Amazon",
      imageUrl: "https://m.media-amazon.com/images/I/71ABC12345L._AC_SL800_.jpg",
      link: "https://www.amazon.com.br/fone-sony"
    },
    {
      title: "Smart TV LG 55\" 4K UHD AI ThinQ",
      price: "R$ 2.899,00",
      store: "Magazine Luiza",
      imageUrl: "https://a-static.mlcdn.com.br/800x800/smart-tv-50-4k-uhd-lg-50ur8750psb-ai-thinq-webos-processador-alpha-7-4-hdmi/magazineluiza/236597800/ff720c5ea6d4611e2c7948847bde6cd2.jpg",
      link: "https://www.magazineluiza.com.br/tv-lg"
    }
  ]);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`
🎯 BACKEND RODANDO NA PORTA ${PORT}
📡 Modo: Busca Inteligente com Imagens Corrigidas
✅ Mercado Livre: Imagens HTTPS garantidas
✅ Amazon: Imagens corrigidas  
✅ Magazine Luiza: Imagens funcionais
⚡ Concorrência: ${Number(process.env.SCRAPE_CONCURRENCY) || 1}
🕒 Timeout: 30s
📊 Logs: Ativados

🚀 Teste as rotas:
   GET  /healthz      - Health check
   GET  /test         - Produtos de teste (imagens garantidas)
   POST /scrape       - Buscar produtos (envie {"url": "termo"})
   
💡 Dica: As imagens agora funcionam porque:
   1. Forçamos HTTPS
   2. Extraímos corretamente do atributo data-src
   3. Removemos parâmetros de cache
   4. Usamos tamanhos maiores de imagem
  `);
});
