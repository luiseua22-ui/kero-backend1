import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { chromium } from "playwright";
import PQueue from "p-queue";
import { JSDOM } from "jsdom";

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
});

app.use(limiter);

const queue = new PQueue({ concurrency: 2 });

// Função melhorada de scraping
async function scrapeProduct(url) {
  return queue.add(async () => {
    let browser;
    try {
      console.log(`🎯 Iniciando scraping para: ${url}`);
      
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      
      // Configurar headers para evitar bloqueios
      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      });

      console.log(`🌐 Navegando para: ${url}`);
      await page.goto(url, { 
        waitUntil: "networkidle", 
        timeout: 30000 
      });

      // Aguardar um pouco para carregar conteúdo dinâmico
      await page.waitForTimeout(3000);

      // Extrair dados com múltiplas estratégias
      const productData = await page.evaluate(() => {
        console.log("🔍 Iniciando extração de dados...");

        // Estratégias para título
        const getTitle = () => {
          const selectors = [
            'h1',
            'h1[class*="product"]',
            'h1[class*="title"]',
            '[class*="product-name"]',
            '[class*="product-title"]',
            '.product-title',
            '.product-name',
            '.title',
            '.name',
            'meta[property="og:title"]',
            'meta[name="title"]',
            'title'
          ];
          
          for (const selector of selectors) {
            try {
              const element = document.querySelector(selector);
              if (element) {
                let text = '';
                if (selector.startsWith('meta')) {
                  text = element.getAttribute('content')?.trim() || '';
                } else if (selector === 'title') {
                  text = element.textContent?.trim() || '';
                } else {
                  text = element.textContent?.trim() || '';
                }
                
                if (text && text.length > 3 && text.length < 200) {
                  console.log(`✅ Título encontrado com seletor: ${selector}`, text);
                  return text;
                }
              }
            } catch (e) {
              console.log(`❌ Erro no seletor ${selector}:`, e);
            }
          }
          return "Produto não encontrado";
        };

        // Estratégias para preço
        const getPrice = () => {
          const priceSelectors = [
            '[class*="price"]',
            '.price',
            '[itemprop="price"]',
            '[data-price]',
            '.product-price',
            '.price-current',
            '.sales-price',
            '.final-price',
            '.value',
            '.cost',
            '.amount',
            '.preco',
            '.valor'
          ];
          
          for (const selector of priceSelectors) {
            try {
              const elements = document.querySelectorAll(selector);
              for (const element of elements) {
                const text = element.textContent?.trim();
                if (text && /R\$\s*\d+[.,]\d+|\d+[.,]\d+\s*R\$|[\d.,]+\s*(reais|RS)|USD\s*[\d.,]+|\d+[.,]\d+/.test(text)) {
                  console.log(`✅ Preço encontrado com seletor: ${selector}`, text);
                  return text.replace(/\s+/g, ' ').substring(0, 50);
                }
              }
            } catch (e) {
              console.log(`❌ Erro no seletor de preço ${selector}:`, e);
            }
          }
          return "Preço não disponível";
        };

        // Estratégias para imagem
        const getImage = () => {
          const imageSelectors = [
            'meta[property="og:image"]',
            'meta[name="og:image"]',
            'meta[property="twitter:image"]',
            '.product-image img',
            '.image img',
            '#image img',
            'img[alt*="produto"]',
            'img[alt*="product"]',
            'img[class*="product"]',
            'img[class*="image"]',
            '.main-image img',
            '.gallery img',
            '.zoomImg',
            '[data-zoom-image]',
            '.product-img',
            '.product-image'
          ];
          
          for (const selector of imageSelectors) {
            try {
              const element = document.querySelector(selector);
              if (element) {
                let src = '';
                if (selector.startsWith('meta')) {
                  src = element.getAttribute('content') || '';
                } else {
                  src = element.getAttribute('src') || 
                         element.getAttribute('data-src') ||
                         element.getAttribute('data-zoom-image') ||
                         '';
                }
                
                if (src) {
                  // Converter URL relativa para absoluta
                  if (src.startsWith('//')) {
                    src = 'https:' + src;
                  } else if (src.startsWith('/')) {
                    src = window.location.origin + src;
                  }
                  
                  if (src.startsWith('http')) {
                    console.log(`✅ Imagem encontrada com seletor: ${selector}`, src.substring(0, 100));
                    return src;
                  }
                }
              }
            } catch (e) {
              console.log(`❌ Erro no seletor de imagem ${selector}:`, e);
            }
          }
          return null;
        };

        return {
          title: getTitle(),
          price: getPrice(),
          image: getImage()
        };
      });

      console.log('📦 Dados extraídos:', productData);

      await browser.close();

      return {
        success: true,
        url,
        title: productData.title,
        price: productData.price,
        image: productData.image,
      };

    } catch (error) {
      console.error('💥 Erro no scraping:', error);
      if (browser) {
        await browser.close();
      }
      throw error;
    }
  });
}

// ENDPOINT /search
app.post("/search", async (req, res) => {
  const { query } = req.body;

  console.log(`🔎 Recebida pesquisa: "${query}"`);

  if (!query) {
    return res.status(400).json({ 
      success: false,
      error: "Parâmetro 'query' ausente" 
    });
  }

  let browser;
  try {
    const searchUrl = "https://www.google.com/search?tbm=shop&hl=pt-BR&q=" + encodeURIComponent(query);
    console.log(`🌐 Buscando no Google Shopping: ${searchUrl}`);

    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });

    await page.goto(searchUrl, { 
      waitUntil: "networkidle", 
      timeout: 20000 
    });

    await page.waitForTimeout(5000);

    const html = await page.content();
    await browser.close();

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Múltiplos seletores para resultados do Google Shopping
    const resultSelectors = [
      ".sh-dgr__content",
      ".sh-dlr__content", 
      ".i0X6df",
      ".sh-dgr__grid-result",
      ".mnr-c",
      ".sh-dgr__grid-result"
    ];

    let items = [];
    
    for (const selector of resultSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        console.log(`📊 Encontrados ${elements.length} resultados com seletor: ${selector}`);
        
        items = Array.from(elements).slice(0, 10).map(el => {
          try {
            // Nome do produto
            const nameSelectors = [
              ".tAxDx",
              ".A2sOrd", 
              ".translate-content",
              "h3",
              "h4",
              ".EI11Pd",
              ".sh-np__product-title"
            ];
            
            let name = "Produto";
            for (const nameSelector of nameSelectors) {
              const nameEl = el.querySelector(nameSelector);
              if (nameEl?.textContent?.trim()) {
                name = nameEl.textContent.trim();
                break;
              }
            }

            // Preço
            const priceSelectors = [
              ".a8Pemb",
              ".T14wmb",
              ".OFFNJ",
              ".a8Pemb OFFNJ",
              '[class*="price"]'
            ];
            
            let price = "Preço não disponível";
            for (const priceSelector of priceSelectors) {
              const priceEl = el.querySelector(priceSelector);
              if (priceEl?.textContent?.trim()) {
                price = priceEl.textContent.trim();
                break;
              }
            }

            // Link
            const linkElement = el.querySelector("a");
            let link = null;
            if (linkElement) {
              const href = linkElement.getAttribute("href");
              if (href) {
                link = href.startsWith("http") ? href : "https://www.google.com" + href;
              }
            }

            // Imagem
            const imageElement = el.querySelector("img");
            let imageUrl = "https://via.placeholder.com/150?text=Sem+Imagem";
            if (imageElement) {
              imageUrl = imageElement.getAttribute("src") || 
                        imageElement.getAttribute("data-src") ||
                        imageElement.getAttribute("data-iurl") ||
                        imageUrl;
            }

            return { 
              name: name || "Produto sem nome", 
              price, 
              link: link || `https://www.google.com/search?q=${encodeURIComponent(query)}`,
              imageUrl
            };
          } catch (itemError) {
            console.error('❌ Erro ao processar item:', itemError);
            return null;
          }
        }).filter(item => item !== null && item.name && item.link);

        break;
      }
    }

    console.log(`✅ Retornando ${items.length} itens para "${query}"`);

    if (items.length === 0) {
      return res.json({
        success: false,
        results: [],
        error: "Nenhum resultado encontrado para: " + query,
      });
    }

    return res.json({
      success: true,
      results: items,
    });

  } catch (err) {
    console.error("💥 Erro no /search:", err);
    if (browser) {
      await browser.close();
    }
    return res.status(500).json({
      success: false,
      error: "Falha ao buscar produtos",
      details: err.message,
    });
  }
});

// Rota principal de scraping
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  console.log(`🎯 Recebida URL para scraping: ${url}`);

  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: "URL ausente" 
    });
  }

  // Validar URL
  try {
    new URL(url);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: "URL inválida: " + url
    });
  }

  try {
    const data = await scrapeProduct(url);
    console.log(`✅ Scraping concluído para: ${url}`);
    res.json(data);
  } catch (err) {
    console.error("💥 Erro no /scrape:", err);
    res.status(500).json({
      success: false,
      error: "Falha ao extrair produto da URL: " + url,
      details: err.message,
    });
  }
});

// Healthcheck - AGORA FUNCIONA VIA GET
app.get("/healthz", (req, res) => {
  res.json({ 
    ok: true,
    message: "Backend está funcionando perfeitamente! ✅",
    timestamp: new Date().toISOString(),
    version: "2.0.0"
  });
});

// Rota de teste - AGORA FUNCIONA VIA GET
app.get("/test", async (req, res) => {
  try {
    console.log("🧪 Teste solicitado...");
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto('https://httpbin.org/user-agent', { 
      waitUntil: "networkidle",
      timeout: 15000 
    });
    const content = await page.textContent('body');
    await browser.close();
    
    res.json({
      success: true,
      message: "✅ Backend e Playwright estão funcionando perfeitamente!",
      test: "Conectado com sucesso à internet",
      content: content ? content.substring(0, 200) + "..." : "Sem conteúdo"
    });
  } catch (error) {
    console.error("💥 Erro no teste:", error);
    res.status(500).json({
      success: false,
      error: "❌ Playwright não está funcionando",
      details: error.message
    });
  }
});

// Rota simples de teste sem Playwright
app.get("/simple-test", (req, res) => {
  res.json({
    success: true,
    message: "✅ Backend está respondendo normalmente!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development"
  });
});

// Rota para testar scraping com exemplo
app.get("/test-scrape", async (req, res) => {
  try {
    const testUrl = "https://www.amazon.com.br";
    console.log(`🧪 Testando scraping com: ${testUrl}`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(testUrl, { 
      waitUntil: "networkidle",
      timeout: 15000 
    });
    const title = await page.title();
    await browser.close();
    
    res.json({
      success: true,
      message: "✅ Scraping teste funcionando!",
      title: title,
      url: testUrl
    });
  } catch (error) {
    console.error("💥 Erro no teste de scraping:", error);
    res.status(500).json({
      success: false,
      error: "❌ Teste de scraping falhou",
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🎉 BACKEND INICIADO COM SUCESSO!`);
  console.log(`📍 Porta: ${PORT}`);
  console.log(`🔗 Health check: https://kero-backend1.onrender.com/healthz`);
  console.log(`🧪 Teste simples: https://kero-backend1.onrender.com/simple-test`);
  console.log(`🌐 Teste scraping: https://kero-backend1.onrender.com/test-scrape`);
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  console.log(`=========================================\n`);
});
