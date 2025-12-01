// index.js - scraper inteligente com múltiplas fontes especializadas
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
  concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 3,
  timeout: 60000
});

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- CLASSIFICAÇÃO DE PRODUTOS ----------------

function detectProductType(query) {
  const q = query.toLowerCase();
  
  const categories = {
    // Eletrônicos e Tecnologia
    'eletronicos': /(celular|smartphone|iphone|samsung|xiaomi|motorola|notebook|laptop|tablet|ipad|smart watch|relógio inteligente|fone de ouvido|airpods|fone bluetooth|mouse|teclado|monitor|tv|smart tv)/,
    'informatica': /(computador|pc|macbook|windows|linux|ssd|hd|memória ram|placa de vídeo|processador|gamer|gaming)/,
    
    // Livros e Mídia
    'livros': /(livro|ebook|kindle|leitor digital|biblioteca|romance|ficção|não ficção|literatura|autor|escrever|ler)/,
    'midia': /(cd|dvd|blu-ray|vinil|filme|série|jogo de tabuleiro|board game)/,
    
    // Moda e Acessórios
    'moda': /(camisa|camiseta|blusa|calça|short|bermuda|vestido|saia|casaco|jaqueta|tênis|sapato|bota|chinelo|sandália|bolsa|mochila|carteira|óculos|relógio|joia|anel|colar|brinco|pulseira)/,
    'luxo': /(rolex|omega|cartier|patek|audemars|breitling|tag heuer|montblanc|louis vuitton|gucci|prada|chanel|hermes|dior)/,
    
    // Casa e Decoração
    'casa': /(sofá|cama|mesa|cadeira|armário|guarda-roupa|estante|prateleira|decoração|quadro|almofada|cortina|tapete|toalha|cama mesa banho)/,
    'eletrodomesticos': /(geladeira|fogão|microondas|lavadora|máquina de lavar|secadora|batedeira|liquidificador|air fryer|fritadeira|panela|pressão)/,
    
    // Esportes e Lazer
    'esportes': /(bola|raquete|tênis esportivo|academia|suplemento|proteína|creatina|bicicleta|skate|patins|equipamento|esportivo)/,
    'brinquedos': /(brinquedo|lego|boneca|carrinho|hot wheels|pelúcia|urso|jogo educativo|infantil)/,
    
    // Beleza e Saúde
    'beleza': /(perfume|maquiagem|batom|rimel|base|creme|shampoo|condicionador|sabonete|esmalte|barbeador|aparelho barbear|depilação)/,
    'saude': /(vitamina|medicamento|termômetro|pressão arterial|aparelho auditivo|órtese|prótese)/,
    
    // Automotivo
    'automotivo': /(pneu|bateria|óleo|motor|capô|parachoque|farol|lanterna|retrovisor|volante|câmbio|freio|suspensão)/,
    
    // Ferramentas e Construção
    'ferramentas': /(martelo|chave|furadeira|parafusadeira|serra|trena|nível|alicante|grampo|tinta|pincel|rolo|argamassa|cimento)/,
    
    // Alimentos e Bebidas
    'alimentos': /(arroz|feijão|macarrão|óleo|açúcar|sal|farinha|biscoito|bolacha|chocolate|doce|geleia|molho|tempero)/,
    'bebidas': /(refrigerante|suco|água|cerveja|vinho|whisky|vodka|rum|licor|cachaça|energético)/,
  };
  
  for (const [category, pattern] of Object.entries(categories)) {
    if (pattern.test(q)) {
      return category;
    }
  }
  
  return 'geral'; // Categoria padrão
}

// ---------------- BUSCA INTELIGENTE COM FONTES ESPECIALIZADAS ----------------

async function searchWithPuppeteer(query) {
  console.log(`🔍 Iniciando busca inteligente para: "${query}"`);
  const productType = detectProductType(query);
  console.log(`🏷️  Categoria detectada: ${productType}`);
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=site-per-process",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ],
  });

  const page = await browser.newPage();
  
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      "upgrade-insecure-requests": "1"
    });

    // Configuração para evitar detecção
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const results = [];
    const sourcesToTry = getSourcesForProductType(productType);
    
    console.log(`📋 Fontes selecionadas: ${sourcesToTry.join(', ')}`);
    
    // Executa busca nas fontes em paralelo para velocidade
    const searchPromises = sourcesToTry.map(source => {
      switch(source) {
        case 'mercadolivre':
          return searchMercadoLivre(page, query).catch(() => []);
        case 'amazon':
          return searchAmazon(page, query).catch(() => []);
        case 'magazineluiza':
          return searchMagazineLuiza(page, query).catch(() => []);
        case 'americanas':
          return searchAmericanas(page, query).catch(() => []);
        case 'submarino':
          return searchSubmarino(page, query).catch(() => []);
        case 'kabum':
          return searchKabum(page, query).catch(() => []);
        case 'fastshop':
          return searchFastShop(page, query).catch(() => []);
        case 'netshoes':
          return searchNetshoes(page, query).catch(() => []);
        case 'centauro':
          return searchCentauro(page, query).catch(() => []);
        case 'zoom':
          return searchZoom(page, query).catch(() => []);
        case 'extra':
          return searchExtra(page, query).catch(() => []);
        case 'pontofrio':
          return searchPontoFrio(page, query).catch(() => []);
        case 'casasbahia':
          return searchCasasBahia(page, query).catch(() => []);
        case 'shoptime':
          return searchShoptime(page, query).catch(() => []);
        case 'dafiti':
          return searchDafiti(page, query).catch(() => []);
        case 'google_shopping':
          return searchGoogleShopping(page, query).catch(() => []);
        default:
          return Promise.resolve([]);
      }
    });
    
    // Aguarda todas as buscas
    const allResults = await Promise.all(searchPromises);
    
    // Combina resultados
    allResults.forEach((sourceResults, index) => {
      results.push(...sourceResults);
      console.log(`✅ ${sourcesToTry[index]}: ${sourceResults.length} produtos`);
    });

    // Remove duplicatas
    const uniqueResults = removeDuplicates(results);
    console.log(`🎯 Total de produtos únicos: ${uniqueResults.length}`);
    
    // Se poucos resultados, tenta busca genérica em mais fontes
    if (uniqueResults.length < 5 && productType !== 'geral') {
      console.log("🔎 Buscando em fontes adicionais...");
      const additionalResults = await searchGenericSources(page, query);
      uniqueResults.push(...additionalResults);
    }
    
    // Ordena por relevância (primeiro resultados das fontes principais)
    const sortedResults = prioritizeResults(uniqueResults, sourcesToTry);
    
    return sortedResults.slice(0, 20);

  } catch (error) {
    console.error("❌ Erro geral na busca:", error);
    return [];
  } finally {
    await browser.close();
  }
}

function getSourcesForProductType(productType) {
  const sourceConfig = {
    // Fontes principais (sempre tentadas primeiro)
    primary: ['mercadolivre', 'amazon', 'magazineluiza'],
    
    // Fontes por categoria
    eletronicos: ['kabum', 'extra', 'fastshop', 'submarino', 'americanas'],
    informatica: ['kabum', 'americanas', 'submarino', 'extra'],
    livros: ['amazon', 'submarino', 'americanas', 'shoptime'],
    midia: ['submarino', 'americanas', 'shoptime', 'extra'],
    moda: ['dafiti', 'netshoes', 'americanas', 'shoptime'],
    luxo: ['mercadolivre', 'americanas', 'extra', 'google_shopping'],
    casa: ['magazineluiza', 'americanas', 'casasbahia', 'pontofrio', 'extra'],
    eletrodomesticos: ['magazineluiza', 'casasbahia', 'pontofrio', 'extra', 'americanas'],
    esportes: ['centauro', 'netshoes', 'americanas', 'submarino'],
    brinquedos: ['magazineluiza', 'americanas', 'submarino', 'shoptime'],
    beleza: ['magazineluiza', 'americanas', 'submarino', 'shoptime'],
    saude: ['magazineluiza', 'americanas', 'drogasil', 'drogaraia'],
    automotivo: ['mercadolivre', 'americanas', 'extra'],
    ferramentas: ['mercadolivre', 'americanas', 'magazineluiza'],
    alimentos: ['mercadolivre', 'paodeacucar', 'extra'],
    bebidas: ['mercadolivre', 'paodeacucar', 'extra'],
    geral: ['mercadolivre', 'amazon', 'magazineluiza', 'americanas', 'submarino', 'google_shopping']
  };
  
  const primary = sourceConfig.primary;
  const specific = sourceConfig[productType] || sourceConfig.geral;
  
  // Combina fontes, removendo duplicatas
  return [...new Set([...primary, ...specific])];
}

function prioritizeResults(results, sourcesOrder) {
  return results.sort((a, b) => {
    // Dá prioridade às fontes principais
    const aIndex = sourcesOrder.indexOf(a.store.toLowerCase().replace(' ', ''));
    const bIndex = sourcesOrder.indexOf(b.store.toLowerCase().replace(' ', ''));
    
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    
    // Depois ordena por preço (mais barato primeiro)
    const priceA = parseFloat(a.price.replace(/[^\d,]/g, '').replace(',', '.'));
    const priceB = parseFloat(b.price.replace(/[^\d,]/g, '').replace(',', '.'));
    
    return priceA - priceB;
  });
}

// ---------------- FUNÇÕES DE BUSCA POR FONTE ----------------

async function searchMercadoLivre(page, query) {
  const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.ui-search-layout__item');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.ui-search-item__title');
          const priceEl = item.querySelector('.andes-money-amount__fraction');
          const imageEl = item.querySelector('.ui-search-result-image__element');
          const linkEl = item.querySelector('.ui-search-link');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = `R$ ${priceEl.textContent.trim()}`;
            const imageUrl = imageEl?.src || imageEl?.getAttribute('data-src') || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Mercado Livre',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchAmazon(page, query) {
  const searchUrl = `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-component-type="s-search-result"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h2 a span');
          const priceWhole = item.querySelector('.a-price-whole');
          const priceFraction = item.querySelector('.a-price-fraction');
          const imageEl = item.querySelector('.s-image');
          const linkEl = item.querySelector('h2 a');
          
          if (titleEl && (priceWhole || priceFraction) && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceWhole && priceFraction 
              ? `R$ ${priceWhole.textContent.trim()}${priceFraction.textContent.trim()}`
              : 'Preço sob consulta';
            const imageUrl = imageEl?.src || '';
            const link = `https://www.amazon.com.br${linkEl.getAttribute('href')}`.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Amazon',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchMagazineLuiza(page, query) {
  const searchUrl = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('[data-testid="product-title"]');
          const priceEl = item.querySelector('[data-testid="price-value"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Magazine Luiza',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchAmericanas(page, query) {
  const searchUrl = `https://www.americanas.com.br/busca/${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Americanas',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchSubmarino(page, query) {
  const searchUrl = `https://www.submarino.com.br/busca/${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Submarino',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchKabum(page, query) {
  const searchUrl = `https://www.kabum.com.br/busca/${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.productCard');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.nameCard');
          const priceEl = item.querySelector('.priceCard');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Kabum',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchFastShop(page, query) {
  const searchUrl = `https://www.fastshop.com.br/web/c/busca?Ntt=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.prateleira ul li');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.product-name');
          const priceEl = item.querySelector('.best-price');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Fast Shop',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchNetshoes(page, query) {
  const searchUrl = `https://www.netshoes.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.item-card');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.item-card__description');
          const priceEl = item.querySelector('.price');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Netshoes',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchCentauro(page, query) {
  const searchUrl = `https://www.centauro.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.product-item');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.product-name');
          const priceEl = item.querySelector('.price');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Centauro',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchZoom(page, query) {
  const searchUrl = `https://www.zoom.com.br/search?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.ProductCard');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.ProductCard-Name');
          const priceEl = item.querySelector('.ProductCard-PriceValue');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Zoom',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchExtra(page, query) {
  const searchUrl = `https://www.extra.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Extra',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchPontoFrio(page, query) {
  const searchUrl = `https://www.pontofrio.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Ponto Frio',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchCasasBahia(page, query) {
  const searchUrl = `https://www.casasbahia.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Casas Bahia',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchShoptime(page, query) {
  const searchUrl = `https://www.shoptime.com.br/busca?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-testid="product-card"]');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('[class*="price__Price"]');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Shoptime',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchDafiti(page, query) {
  const searchUrl = `https://www.dafiti.com.br/busca/?q=${encodeURIComponent(query)}`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.product-box');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('.product-name');
          const priceEl = item.querySelector('.price');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Dafiti',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchGoogleShopping(page, query) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop`;
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    return await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.sh-dgr__content');
      
      items.forEach(item => {
        try {
          const titleEl = item.querySelector('h3');
          const priceEl = item.querySelector('.a8Pemb');
          const imageEl = item.querySelector('img');
          const linkEl = item.querySelector('a');
          
          if (titleEl && priceEl && linkEl) {
            const title = titleEl.textContent.trim();
            const price = priceEl.textContent.trim();
            const imageUrl = imageEl?.src || '';
            const link = linkEl.href.split('?')[0];
            
            results.push({
              title: title.length > 80 ? title.substring(0, 80) + '...' : title,
              price,
              store: 'Google Shopping',
              imageUrl,
              link
            });
          }
        } catch (e) {}
      });
      
      return results.slice(0, 10);
    });
  } catch (error) {
    return [];
  }
}

async function searchGenericSources(page, query) {
  // Fontes genéricas adicionais
  const sources = [
    { name: 'Walmart', url: `https://www.walmart.com.br/busca?q=${encodeURIComponent(query)}` },
    { name: 'Carrefour', url: `https://www.carrefour.com.br/busca?q=${encodeURIComponent(query)}` },
    { name: 'MadeiraMadeira', url: `https://www.madeiramadeira.com.br/busca?q=${encodeURIComponent(query)}` },
  ];
  
  const results = [];
  
  for (const source of sources) {
    try {
      await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(1000);
      
      const sourceResults = await page.evaluate((storeName) => {
        const localResults = [];
        const items = document.querySelectorAll('[class*="product"], [class*="card"], [class*="item"]');
        
        items.slice(0, 5).forEach(item => {
          try {
            const titleEl = item.querySelector('h3, h2, .title, .name');
            const priceEl = item.querySelector('.price, .value, .cost');
            const imageEl = item.querySelector('img');
            const linkEl = item.querySelector('a');
            
            if (titleEl && priceEl && linkEl) {
              const title = titleEl.textContent.trim();
              const price = priceEl.textContent.trim();
              const imageUrl = imageEl?.src || '';
              const link = linkEl.href.split('?')[0];
              
              localResults.push({
                title: title.length > 80 ? title.substring(0, 80) + '...' : title,
                price: price.includes('R$') ? price : `R$ ${price}`,
                store: storeName,
                imageUrl,
                link
              });
            }
          } catch (e) {}
        });
        
        return localResults;
      }, source.name);
      
      results.push(...sourceResults);
    } catch (error) {
      continue;
    }
  }
  
  return results;
}

function removeDuplicates(products) {
  const seen = new Set();
  const unique = [];
  
  for (const product of products) {
    if (!product.title || !product.price) continue;
    
    // Cria uma chave única baseada no título e preço
    const key = `${product.title.substring(0, 50).toLowerCase()}_${product.price}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(product);
    }
  }
  
  return unique;
}

// ---------------- FUNÇÕES ORIGINAIS MANTIDAS (para scraping de URL única) ----------------

function sanitizeIncomingUrl(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map(m => m[0]);
    if (matches.length > 0) return matches[0];
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try { return new URL(s).toString(); } catch (e) { return null; }
}

async function autoScroll(page, maxScroll = 2400) {
    await page.evaluate(async (maxScroll) => {
        await new Promise((resolve) => {
            let total = 0;
            const distance = 200;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                total += distance;
                if (total >= maxScroll || total >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 120);
        });
    }, maxScroll);
}

async function querySelectorShadowReturn(page, selector) {
    return page.evaluate((sel) => {
        function search(root) {
            try {
                if (root.querySelector) {
                    const found = root.querySelector(sel);
                    if (found) return found;
                }
                const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
                for (const n of nodes) {
                    try {
                        if (n.shadowRoot) {
                            const r = search(n.shadowRoot);
                            if (r) return r;
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        }
        const el = search(document);
        if (!el) return null;
        if (el.tagName === 'IMG') return { type: 'img', src: el.currentSrc || el.src || null };
        if (el.tagName === 'META') return { type: 'meta', content: el.content || null };
        return { type: 'other', text: (el.innerText || el.textContent || '').trim() || null };
    }, selector);
}

function createXHRPriceCollector(page) {
    const prices = [];
    page.on("response", async (resp) => {
        try {
            const url = resp.url().toLowerCase();
            if (
                url.includes("price") ||
                url.includes("offer") ||
                url.includes("offers") ||
                url.includes("sku") ||
                url.includes("product") ||
                url.includes("pricing") ||
                url.includes("/item") ||
                url.includes("/products")
            ) {
                const ctype = (resp.headers && resp.headers()["content-type"]) || "";
                if (!ctype.includes("application/json")) return;
                const json = await resp.json().catch(() => null);
                if (!json) return;

                const walk = (o) => {
                    if (!o || typeof o !== "object") return;
                    for (const k of Object.keys(o)) {
                        const v = o[k];
                        const lkey = String(k).toLowerCase();
                        if (v === null || v === undefined) continue;

                        if (typeof v === "string" || typeof v === "number") {
                            const text = String(v).trim();
                            const inst = text.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || text.match(/(\d{1,3})x([\d\.,]+)/i);

                            if (inst) {
                                prices.push({ raw: text, source: "xhr", isInstallment: true, parcelCount: Number(inst[1]), parcelValueRaw: inst[2], url });
                                prices.push({ raw: `computed_installment_total:${inst[1]}x${inst[2]}`, source: "xhr", computedFrom: { count: Number(inst[1]), rawValue: inst[2] }, url });
                            } else {
                                const isPriceKey = lkey.includes("price") || lkey.includes("sale") || lkey.includes("offer") || lkey.includes("total") || lkey.includes("custo");
                                if (isPriceKey) {
                                    prices.push({ raw: text, source: "xhr", field: k, url });
                                }
                            }
                        }
                        if (typeof v === "object") walk(v);
                    }
                };
                walk(json);
            }
        } catch (e) {
            // ignore
        }
    });
    return () => prices;
}

function parseNumberFromString(raw) {
    if (raw === null || raw === undefined) return { num: null, note: "empty" };
    let s = String(raw).trim();
    if (!s) return { num: null, note: "empty" };

    s = s.replace(/\u00A0/g, "");
    s = s.replace(/(R\$|BRL|\$)/gi, "");

    const cleaned = s.replace(/[^0-9\.,]/g, "");
    if (!cleaned) return { num: null, note: "no digits" };
    let t = cleaned;

    if (t.includes(".") && t.includes(",")) {
        t = t.replace(/\./g, "").replace(",", ".");
    } else if (t.includes(",") && !t.includes(".")) {
        const parts = t.split(",");
        if (parts[1] && parts[1].length <= 2) {
            t = t.replace(",", ".");
        } else {
            t = t.replace(/,/g, "");
        }
    } else if (t.includes(".") && !t.includes(",")) {
        const parts = t.split(".");
        if (!(parts[1] && parts[1].length === 2)) {
            t = t.replace(/\./g, "");
        }
    }

    t = t.replace(/[^0-9.]/g, "");
    if (!t) return { num: null, note: "cleaned empty" };

    let n = Number(t);
    if (!Number.isFinite(n)) return { num: null, note: "not finite" };

    const digitsOnly = t.replace(".", "");
    const hasDecimalPoint = t.includes('.');

    if (!hasDecimalPoint && /^\d+$/.test(digitsOnly) && digitsOnly.length >= 7 && n > 10000) {
        return { num: n / 100, note: "cent heuristic" };
    }

    return { num: n, note: "parsed" };
}

function detectInstallmentFromString(raw) {
    if (!raw) return null;
    const s = String(raw);
    const m = s.match(/(\d{1,3})\s*[xX]\s*(?:de\s*)?R?\$?\s*([\d\.,]+)/i) || s.match(/(\d{1,3})x([\d\.,]+)/i) || s.match(/(\d{1,3})\s*vezes?\s*de\s*R?\$?\s*([\d\.,]+)/i);
    if (!m) return null;
    const count = Number(m[1]);
    const valueRaw = m[2];
    const parsed = parseNumberFromString(valueRaw);
    if (parsed.num && count > 0) return { count, parcelValue: parsed.num, total: parsed.num * count };
    return null;
}

async function findPricesNearCTA(page) {
    return page.evaluate(() => {
        const ctaSelectors = [
            "button.add-to-cart", "button#adicionar", "button[aria-label*='carrinho']",
            "button[aria-label*='comprar']", "button[title*='Comprar']", "button[type='submit']",
            ".buy-button", ".buyNow", ".add-to-cart-button", ".productActionAdd", ".add-to-cart",
            "a.add-to-cart", "a[href*='add-to-cart']"
        ];
        const priceCandidates = new Set();
        const priceRegex = /(?:\d{1,3}\s*[xX]\s*R\$\s*[\d\.,]+|R\$\s?[\d\.,]+)/g;

        function collectNearbyTexts(el) {
            const texts = [];
            try {
                if (el && el.innerText) texts.push(el.innerText);
                if (el && el.parentElement) {
                    for (const sib of Array.from(el.parentElement.children)) {
                        if (sib && sib !== el && sib.innerText) texts.push(sib.innerText);
                    }
                }
                let node = el.parentElement;
                for (let i = 0; i < 4 && node; i++) {
                    if (node && node.innerText) texts.push(node.innerText);
                    node = node.parentElement;
                }
                if (el && el.querySelectorAll) {
                    for (const d of Array.from(el.querySelectorAll("*"))) {
                        if (d.innerText) texts.push(d.innerText);
                    }
                }
            } catch (e) { }
            return texts;
        }

        for (const sel of ctaSelectors) {
            try {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const n of nodes) {
                    const texts = collectNearbyTexts(n);
                    for (const t of texts) {
                        const matches = t.match(priceRegex);
                        if (matches) matches.forEach(m => priceCandidates.add(m.trim()));
                    }
                }
            } catch (e) { }
        }

        const textCTAs = Array.from(document.querySelectorAll("button, a")).filter(n => {
            const txt = (n.innerText || "").toLowerCase();
            return txt.includes("comprar") || txt.includes("adicionar") || txt.includes("cart") || txt.includes("carrinho") || txt.includes("buy") || txt.includes("add to cart");
        });
        for (const n of textCTAs) {
            const texts = collectNearbyTexts(n);
            for (const t of texts) {
                const matches = t.match(priceRegex);
                if (matches) matches.forEach(m => priceCandidates.add(m.trim()));
            }
        }

        return Array.from(priceCandidates);
    });
}

function selectBestPrice(candidatesWithMeta, proximityMap = {}, debug) {
    if (!Array.isArray(candidatesWithMeta) || candidatesWithMeta.length === 0) {
        debug.reason = "no_candidates";
        return null;
    }

    const augmented = candidatesWithMeta.slice();

    const standaloneNumbers = augmented
        .map(c => ({ c, raw: String(c.raw || "").trim() }))
        .filter(x => /^\d{1,3}$/.test(x.raw))
        .map(x => Number(x.raw));

    for (const p of augmented.slice()) {
        const inst = detectInstallmentFromString(String(p.raw || ""));
        if (inst && inst.total) {
            augmented.push({ raw: `computed_installment_total:${inst.count}x${inst.parcelValue}`, source: p.source || "detected", computedTotal: true, from: p.raw });
        }
    }

    if (standaloneNumbers.length && augmented.some(c => /R\$/i.test(String(c.raw || "")))) {
        for (const n of standaloneNumbers) {
            const pricePerList = augmented.filter(c => /R\$/i.test(String(c.raw || "")) && !detectInstallmentFromString(String(c.raw || "")));
            for (const per of pricePerList) {
                const parsed = parseNumberFromString(per.raw);
                if (parsed.num) {
                    const total = parsed.num * n;
                    augmented.push({ raw: `computed_pair_total:${n}x${per.raw}`, source: "paired", computedTotal: true, numComputed: total, from: `${n} x ${per.raw}` });
                }
            }
        }
    }

    const processed = [];
    for (const c of augmented) {
        const raw = String(c.raw || "").trim();
        if (!raw) continue;

        const comp = raw.match(/^computed_installment_total:(\d+)x(.+)$/i) || raw.match(/^computed_pair_total:(\d+)x(.+)$/i);
        if (comp) {
            const count = Number(comp[1]);
            const parsed = parseNumberFromString(comp[2]);
            if (parsed.num) {
                const total = parsed.num * count;
                processed.push({ raw, source: c.source || "computed", num: total, computedTotal: true, note: parsed.note || null, extra: c });
                debug.trace && debug.trace.push({ action: "computed_marker_parsed", raw, total });
                continue;
            }
            if (c.numComputed) {
                processed.push({ raw, source: c.source || "computed", num: c.numComputed, computedTotal: true, note: "numComputed" });
                debug.trace && debug.trace.push({ action: "computed_marker_numComputed", raw, numComputed: c.numComputed });
                continue;
            }
        }

        const inst = detectInstallmentFromString(raw);
        if (inst && inst.total) {
            processed.push({ raw, source: c.source || "mixed", num: inst.total, computedTotal: true, note: "detected-installment" });
            processed.push({ raw: raw + "_per", source: c.source || "mixed", num: inst.parcelValue, isParcel: true, parcelCount: inst.count });
            debug.trace && debug.trace.push({ action: "installment_detected", raw, parsed: inst });
            continue;
        }

        const p = parseNumberFromString(raw);
        if (p.num) {
            processed.push({ raw, source: c.source || "unknown", num: p.num, isParcel: false, note: p.note, extra: c });
            continue;
        }

        const digitsOnly = raw.replace(/\D/g, "");
        if (digitsOnly.length > 0 && /^\d+$/.test(digitsOnly)) {
            const asNum = Number(digitsOnly);
            if (!Number.isNaN(asNum) && asNum > 0) {
                if (digitsOnly.length <= 6) processed.push({ raw, source: c.source || "unknown", num: asNum, inferredInteger: true, extra: c });
                else processed.push({ raw, source: c.source || "unknown", num: asNum, inferredInteger: true, likelyId: true, extra: c });
            }
        }
    }

    debug.processedCandidates = processed.map(p => ({ raw: p.raw, num: p.num, note: p.note || null, source: p.source }));

    if (processed.length === 0) {
        debug.reason = "no_processed_numeric_candidates";
        return null;
    }

    const freq = {};
    processed.forEach(p => {
        if (p.num == null) return;
        const k = Number(p.num).toFixed(2);
        freq[k] = (freq[k] || 0) + 1;
    });

    const uniqueNums = Array.from(new Set(processed.filter(p => Number.isFinite(p.num)).map(p => p.num))).sort((a, b) => a - b);
    const median = uniqueNums.length ? uniqueNums[Math.floor(uniqueNums.length / 2)] : null;
    const max = uniqueNums.length ? Math.max(...uniqueNums) : null;

    const scored = processed
        .filter(p => Number.isFinite(p.num))
        .map(p => {
            let score = 0;
            const src = String(p.source || "");
            const field = String(p.extra?.field || "").toLowerCase();

            if (src.includes("jsonld")) score += 80;
            else if (src.includes("selector")) score += 60;
            else if (src.includes("nearCTA")) score += 35;
            else if (src.includes("xhr")) score += 20;
            else if (src.includes("body")) score += 5;
            else score += 5;

            if (p.computedTotal) score += 5;
            if (p.isParcel) score -= 50;

            if (field.includes("original") || field.includes("old") || field.includes("from")) {
                score -= 30;
            }
            if (field.includes("sale") || field.includes("best") || field.includes("offer") || field.includes("current")) {
                score += 20;
            }

            if (/R\$/i.test(p.raw)) score += 15;

            const f = freq[Number(p.num).toFixed(2)] || 0;
            score += Math.min(f, 5) * 6;

            try {
                const prox = proximityMap[p.raw];
                if (prox) {
                    if (prox.near) score += 30;
                    score += Math.min(prox.count || 0, 5) * 2;
                }
            } catch (e) { }

            if (p.likelyId) score -= 90;
            if (p.num < 5) score -= 30;
            if (p.num > 1000000) score -= 100;

            if (median && median > 0) {
                const ratio = p.num / median;
                if (ratio >= 0.2 && ratio <= 20) score += 4;
                if (ratio < 0.02) score -= 12;
                if (ratio > 50) score -= 18;
            }

            const hasExplicitCurrency = processed.some(pp => /R\$/i.test(pp.raw));
            if (hasExplicitCurrency && !/R\$/i.test(p.raw)) score -= 10;
            if (max && max > 0) score += (p.num / max) * 2;

            return { ...p, score };
        });

    scored.sort((a, b) => b.score - a.score);

    debug.scored = scored.map(s => ({ raw: s.raw, num: s.num, score: s.score, source: s.source, note: s.note || null }));

    const best = scored[0];
    if (!best) {
        debug.reason = "no_best_candidate";
        return null;
    }

    if (best && /cent heuristic/i.test(best.note || "") && processed.some(p => /R\$/i.test(p.raw))) {
        const explicit = scored.find(s => /R\$/i.test(s.raw));
        if (explicit) {
            debug.finalChoice = { chosen: explicit, reason: "explicit_currency_preferred_over_cent_heuristic" };
            return `R$ ${Number(explicit.num).toFixed(2).replace(".", ",")}`;
        }
    }

    debug.finalChoice = { chosen: best, reason: "highest_score" };

    return `R$ ${Number(best.num).toFixed(2).replace(".", ",")}`;
}

async function scrapeProduct(rawUrl) {
    return queue.add(async () => {
        const debug = { trace: [], processedCandidates: null, scored: null, finalChoice: null, reason: null };
        const cleaned = sanitizeIncomingUrl(rawUrl);
        debug.rawUrl = rawUrl;
        debug.cleaned = cleaned;
        console.log("URL RECEBIDA:", rawUrl);
        console.log("URL SANITIZADA:", cleaned);
        if (!cleaned) return { success: false, error: "URL inválida", debug };

        const browser = await puppeteer.launch({
            headless: process.env.PUPPETEER_HEADLESS === "false" ? false : "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-features=site-per-process",
                "--window-size=1920,1080"
            ],
            defaultViewport: { width: 1920, height: 1080 }
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            try {
                const url = req.url().toLowerCase();
                const resourceType = req.resourceType ? req.resourceType() : "";
                if (resourceType === "font" || resourceType === "stylesheet") return req.abort();
                const blocked = ["googlesyndication", "google-analytics", "doubleclick", "adsystem", "adservice", "facebook", "hotjar", "segment", "matomo", "ads", "tracking"];
                if (blocked.some(d => url.includes(d))) return req.abort();
            } catch (e) { }
            return req.continue();
        });

        await page.setUserAgent(process.env.USER_AGENT || DEFAULT_USER_AGENT);
        await page.setExtraHTTPHeaders({ "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

        const collectXHR = createXHRPriceCollector(page);

        try {
            try {
                await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
            } catch (err) {
                console.warn("networkidle2 falhou, tentando domcontentloaded:", err && (err.message || err));
                debug.trace.push({ action: "navigation_fallback", message: String(err) });
                await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
            }

            await page.waitForTimeout(600);
            await autoScroll(page, 1800);
            await page.waitForTimeout(700);

            let title = null;
            let image = null;
            const candidates = [];

            // JSON-LD
            try {
                const blocks = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
                for (const block of blocks) {
                    let parsed = null;
                    try { parsed = JSON.parse(block); } catch (e) { parsed = null; debug.trace.push({ action: "jsonld_parse_error", error: String(e) }); }
                    if (!parsed) continue;
                    const list = Array.isArray(parsed) ? parsed : [parsed];
                    for (const item of list.flat()) {
                        if (!item) continue;
                        if (!title && (item.name || item.title)) title = item.name || item.title;
                        if (!image && item.image) {
                            const img = Array.isArray(item.image) ? item.image[0] : item.image;
                            image = typeof img === "object" ? img.url || img.contentUrl : img;
                        }
                        if (item.offers) {
                            const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                            for (const o of offers) {
                                if (o.price) { candidates.push({ raw: String(o.price), source: "jsonld" }); debug.trace.push({ action: "jsonld_price", raw: String(o.price) }); }
                                if (o.price && o.priceCurrency) { candidates.push({ raw: `${o.priceCurrency} ${o.price}`, source: "jsonld" }); debug.trace.push({ action: "jsonld_price_currency", raw: `${o.priceCurrency} ${o.price}` }); }
                                if (o.installments && o.installments.number && o.installments.price) {
                                    candidates.push({ raw: `${o.installments.number} x ${o.installments.price}`, source: "jsonld" });
                                    debug.trace.push({ action: "jsonld_installments", raw: `${o.installments.number} x ${o.installments.price}` });
                                }
                            }
                        }
                    }
                }
            } catch (e) { debug.trace.push({ action: "jsonld_top_error", error: String(e) }); }

            // OpenGraph fallback
            const ogTitle = await page.$eval("meta[property='og:title']", e => e.content).catch(() => null);
            if (ogTitle && !title) { title = ogTitle; debug.trace.push({ action: "og_title_used", raw: ogTitle }); }
            const ogImage = await page.$eval("meta[property='og:image']", e => e.content).catch(() => null);
            if (ogImage && !image) { image = ogImage; debug.trace.push({ action: "og_image_used", raw: ogImage }); }

            // visible selectors
            const selectorList = [
                '[itemprop="price"]',
                '[itemprop="priceSpecification"]',
                ".price",
                ".product-price",
                ".sales-price",
                ".best-price",
                ".valor",
                ".priceFinal",
                ".productPrice",
                ".price--main",
                ".product-price-amount",
                ".productPriceAmount",
                ".price__amount",
                ".priceValue",
                "s", "del",
                ".list-price", ".original-price", ".price--original", ".old-price", ".priceBox__from"
            ];
            for (const sel of selectorList) {
                const vals = await page.$$eval(sel, els => els.map(e => (e.getAttribute('content') || e.getAttribute('data-price') || e.getAttribute('data-price-amount') || (e.innerText || e.textContent || '').trim())).filter(Boolean)).catch(() => []);
                for (const v of vals) { candidates.push({ raw: v, source: "selector" }); debug.trace.push({ action: "selector_found", sel, raw: v }); }
                const shadow = await querySelectorShadowReturn(page, sel).catch(() => null);
                if (shadow && shadow.text) { candidates.push({ raw: shadow.text, source: "selector" }); debug.trace.push({ action: "shadow_selector", sel, raw: shadow.text }); }
                if (shadow && shadow.src && !image) { image = shadow.src; debug.trace.push({ action: "shadow_image_used", src: shadow.src }); }
            }

            // XHR
            const xhrList = collectXHR();
            debug.trace.push({ action: "xhr_count", count: xhrList.length || 0 });
            for (const o of xhrList) {
                if (!o) continue;
                if (typeof o === "object" && o.raw) { candidates.push(o); debug.trace.push({ action: "xhr_candidate", raw: o.raw, meta: o }); }
                else { candidates.push({ raw: String(o), source: "xhr" }); debug.trace.push({ action: "xhr_candidate_raw", raw: String(o) }); }
            }

            // near CTA
            const nearCTAPrices = await findPricesNearCTA(page).catch(() => []);
            debug.trace.push({ action: "near_cta_count", count: nearCTAPrices.length || 0 });
            for (const p of nearCTAPrices) { candidates.push({ raw: p, source: "nearCTA" }); debug.trace.push({ action: "nearcta_candidate", raw: p }); }

            // body fallback
            const body = await page.evaluate(() => document.body.innerText).catch(() => "");
            if (body) {
                const matches = new Set();
                const instRegex = /(\d{1,3}\s*[xX]\s*(?:de\s*)?R?\$?\s*[\d\.,]+)/g;
                const currencyRegex = /R\$\s?[\d\.,]+/g;
                const plainNumberRegex = /\b\d{1,3}\b/g;

                const instFound = body.match(instRegex) || [];
                instFound.forEach(s => matches.add(s.trim()));

                const currFound = body.match(currencyRegex) || [];
                currFound.forEach(s => matches.add(s.trim()));

                const maybeCounts = body.match(plainNumberRegex) || [];
                maybeCounts.forEach(s => {
                    const n = Number(s);
                    if (!isNaN(n) && n >= 2 && n <= 60) matches.add(String(s));
                });

                for (const m of Array.from(matches)) { candidates.push({ raw: m, source: "body" }); debug.trace.push({ action: "body_candidate", raw: m }); }
            }

            // dedupe
            const seen = new Set();
            const dedup = [];
            for (const c of candidates) {
                if (!c || !c.raw) continue;
                const key = String(c.raw).trim();
                if (seen.has(key)) continue;
                seen.add(key);
                dedup.push(c);
            }

            console.log("RAW PRICE CANDIDATES:", dedup.slice(0, 200));
            debug.rawCandidates = dedup.slice(0, 200);

            // proximity info
            const uniqueRaw = Array.from(new Set(dedup.map(c => String(c.raw))));
            const proximityInfo = await page.evaluate((cands, titleText, imageUrl) => {
                const info = {};
                cands.forEach(c => info[c] = { near: false, count: 0 });
                const titleEls = titleText ? Array.from(document.querySelectorAll("h1, .product-title, .product-name")).filter(el => (el.innerText || el.textContent || "").includes(titleText)) : [];
                const imgEls = imageUrl ? Array.from(document.querySelectorAll("img")).filter(img => (img.src || img.currentSrc).includes(imageUrl)) : [];
                const ctxEls = [...titleEls, ...imgEls];
                function near(node, ctx) {
                    if (!node || !ctx) return false;
                    let p = node;
                    for (let i = 0; i < 6 && p; i++) {
                        if (ctx.includes(p)) return true;
                        p = p.parentElement;
                    }
                    return false;
                }
                cands.forEach(c => {
                    const nodes = Array.from(document.querySelectorAll("body *")).filter(n => (n.innerText || n.textContent || "").includes(c));
                    info[c].count = nodes.length;
                    for (const n of nodes) {
                        if (near(n, ctxEls)) { info[c].near = true; break; }
                    }
                });
                return info;
            }, uniqueRaw, title || "", image || "");

            debug.proximityInfo = proximityInfo;

            // final price selection
            const finalPrice = selectBestPrice(dedup, proximityInfo, debug);

            if (title && typeof title === "string") title = title.split("|")[0].split("-")[0].trim();

            await browser.close();

            return {
                success: true,
                url: cleaned,
                title: title || null,
                price: finalPrice || null,
                image: image || null,
                rawCandidatesCount: dedup.length,
                debug
            };
        } catch (err) {
            await browser.close().catch(() => { });
            console.error("SCRAPER ERROR:", err && (err.message || err));
            debug.error = String(err);
            return { success: false, error: String(err), debug };
        }
    });
}

// ---------------- ROTAS ----------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
    try {
        const url = req.body?.url || req.query?.url;
        
        if (!url) {
            return res.status(400).json({ success: false, error: "Parâmetro 'url' é obrigatório" });
        }

        const isUrl = url && (url.startsWith('http://') || url.startsWith('https://'));

        if (isUrl) {
            console.log(`Scraping individual para: ${url}`);
            const result = await scrapeProduct(url);
            res.json(result);
        } else {
            console.log(`\n📍 NOVA BUSCA: "${url}"`);
            
            if (url.trim().length < 2) {
                return res.json([]);
            }

            const products = await searchWithPuppeteer(url);
            
            console.log(`📊 Produtos retornados para "${url}":`, products.length);
            
            res.json(products);
        }

    } catch (error) {
        console.error("ROUTE ERROR:", error.message);
        res.status(500).json({ 
            success: false, 
            error: "Erro interno do servidor",
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🎯 Backend rodando na porta ${PORT}`);
  console.log(`📡 Modo: Busca Inteligente Multi-fonte`);
  console.log(`🏷️  Categorias: Eletrônicos, Livros, Moda, Casa, Esportes, Beleza, etc.`);
  console.log(`⭐ Fontes: 15+ marketplaces brasileiros`);
  console.log(`⚡ Concorrência: ${Number(process.env.SCRAPE_CONCURRENCY) || 3} requests\n`);
});
