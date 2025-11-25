import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Plugins
puppeteer.use(StealthPlugin());

// App
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Rate limit (protege o backend)
const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

// Fila de concorrência para evitar muitos browsers simultâneos
const queue = new PQueue({ concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2 });

// User-Agent padrão
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Helpers ---------------------------------------------------------

function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();

  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map(m => m[0]);
  if (matches.length > 0) return matches[0];

  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  try {
    return new URL(s).toString();
  } catch (e) {
    return null;
  }
}

async function autoScroll(page, maxScroll = 2000) {
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
      }, 150);
    });
  }, maxScroll);
}

async function querySelectorShadow(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      try {
        if (root.querySelector) {
          const found = root.querySelector(sel);
          if (found) return found;
        }
        const nodes = (root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : []);
        for (const n of nodes) {
          if (n.shadowRoot) {
            const r = search(n.shadowRoot);
            if (r) return r;
          }
        }
      } catch (e) {}
      return null;
    }
    const result = search(document);
    if (!result) return null;
    const el = result;
    if (el.tagName === 'IMG') return { type: 'img', src: el.src || el.currentSrc || null };
    if (el.tagName === 'META') return { type: 'meta', content: el.content || null };
    return { type: 'other', text: (el.innerText || el.textContent || '').trim() || null };
  }, selector);
}

function createXHRPriceCollector(page) {
  const prices = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url().toLowerCase();
      if (url.includes('/price') || url.includes('/offers') || url.includes('/product') || url.includes('/pricing') || url.includes('price') || url.includes('item')) {
        const ctype = resp.headers()['content-type'] || '';
        if (ctype.includes('application/json')) {
          const json = await resp.json().catch(() => null);
          if (json) {
            const candidates = [];
            const walk = (o) => {
              if (!o || typeof o !== 'object') return;
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (k.toLowerCase().includes('price') && (typeof v === 'string' || typeof v === 'number')) candidates.push(String(v));
                if (k.toLowerCase().includes('amount') && (typeof v === 'string' || typeof v === 'number')) candidates.push(String(v));
                if (typeof v === 'object') walk(v);
              }
            };
            walk(json);
            candidates.forEach(p => prices.push({ src: url, value: p }));
          }
        }
      }
    } catch (e) {}
  });
  return () => prices;
}

// 🔥 NOVA FUNÇÃO DE NORMALIZAÇÃO DE PREÇO — SUPER PRECISA
function normalizePrice(raw) {
  if (!raw) return null;

  let txt = String(raw)
    .replace(/\s+/g, "")
    .replace("R$", "")
    .replace(/[^0-9.,]/g, "")
    .trim();

  // Remove pontos que são milhares
  if (txt.includes(".")) {
    const parts = txt.split(".");
    if (parts.length > 2) {
      txt = parts.join("");
    } else if (parts[1].length === 3) {
      txt = parts.join("");
    }
  }

  txt = txt.replace(",", ".");

  const num = Number(txt);
  if (isNaN(num) || num === 0) return raw;

  return `R$ ${num.toFixed(2).replace(".", ",")}`;
}

// MAIN SCRAPER --------------------------------------------------
async function scrapeProduct(rawUrl) {
  return queue.add(async () => {
    const cleaned = sanitizeIncomingUrl(rawUrl);
    console.log("URL RECEBIDA:", rawUrl);
    console.log("URL SANITIZADA:", cleaned);
    if (!cleaned) return { success: false, error: "URL inválida" };

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=site-per-process",
        "--window-size=1920,1080",
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });

    const page = await browser.newPage();

    try {
      await page.setUserAgent(process.env.USER_AGENT || DEFAULT_USER_AGENT);
      await page.setExtraHTTPHeaders({
        "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      });

      const getCollectedPrices = createXHRPriceCollector(page);

      let navOk = false;
      try {
        await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
        navOk = true;
      } catch (err1) {
        console.warn("networkidle2 falhou, tentando domcontentloaded...", err1.message);
        try {
          await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
          await page.waitForTimeout(1200);
          navOk = true;
        } catch (err2) {
          try {
            await page.goto(cleaned, { timeout: 60000 });
            navOk = true;
          } catch (err3) {
            await browser.close();
            return { success: false, error: `Falha ao acessar a URL: ${err3.message}` };
          }
        }
      }

      await page.waitForTimeout(800);
      await autoScroll(page, 2400);
      await page.waitForTimeout(700);

      let title = null;
      let price = null;
      let image = null;

      // JSON-LD
      try {
        const jsonLdBlocks = await page.$$eval('script[type="application/ld+json"]', nodes =>
          nodes.map(n => n.textContent).filter(Boolean)
        );
        for (const block of jsonLdBlocks) {
          try {
            const parsed = JSON.parse(block);
            const list = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of list.flat()) {
              if (!item) continue;
              if (!title && (item.name || item.title)) title = item.name || item.title;
              if (!image && item.image) {
                const img = Array.isArray(item.image) ? item.image[0] : item.image;
                image = typeof img === 'object' ? (img.url || img.contentUrl) : img;
              }
              if (!price && item.offers) {
                const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                const valid = offers.find(o => o.price && parseFloat(String(o.price)) > 0);
                if (valid) price = valid.price;
              }
            }
          } catch (e){}
        }
      } catch (e) {}

      // OpenGraph
      if (!title) {
        title = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => null);
      }
      if (!image) {
        image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
      }

      // FallBack manual de título / imagem / preço
      try {
        if (!title) {
          const t = await page.evaluate(() => {
            const s = ['h1', '.product-title', '.product-name', '.pdp-title', '.productTitle'];
            for (const sel of s) {
              const el = document.querySelector(sel);
              if (el) return (el.innerText || el.textContent || '').trim();
            }
            return null;
          });
          if (t) title = t;
        }

        if (!image) {
          const imgSel = ['img#product-image', '.product-image img', '.pdp-image img', '.gallery img', '.image img'];
          for (const sel of imgSel) {
            const src = await page.$eval(sel, el => el.currentSrc || el.src).catch(() => null);
            if (src) { image = src; break; }
          }
        }

        if (!price) {
          const priceSelectors = [
            '[itemprop="price"]',
            '.price',
            '.product-price',
            '.sales-price',
            '.best-price',
            '.valor',
            '.priceFinal',
            '.productPrice',
            '.price--main',
            '.product-price-amount'
          ];
          for (const sel of priceSelectors) {
            const txt = await page.$eval(sel, el => el.innerText || el.textContent || el.getAttribute('content')).catch(() => null);
            if (txt) {
              price = txt;
              break;
            }
            const shadow = await querySelectorShadow(page, sel).catch(() => null);
            if (shadow && shadow.text) { price = shadow.text; break; }
            if (shadow && shadow.src) { image = shadow.src; }
          }
        }
      } catch (e) {}

      // preços via XHR
      try {
        const collected = getCollectedPrices();
        if ((!price || price.length < 3) && collected.length) {
          const candidate = collected.find(c => c.value)?.value;
          if (candidate) price = candidate;
        }
      } catch (e) {}

      // fallback via leitura do texto inteiro da página
      if (!price) {
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const m = bodyText.match(/R\$\s?[\d\.,]+/);
        if (m) price = m[0];
      }

      // LIMPEZA FINAL
      const formattedPrice = normalizePrice(price);

      if (title && typeof title === 'string')
        title = title.split('|')[0].split('-')[0].trim();

      await browser.close();

      return {
        success: true,
        url: cleaned,
        title: title || null,
        price: formattedPrice || null,
        image: image || null,
      };

    } catch (err) {
      try { await browser.close(); } catch(e) {}
      console.error("Erro na tarefa de scraping:", err);
      return { success: false, error: String(err) };
    }
  });
}

// Route: health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Route: scrape
app.post('/scrape', async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL ausente" });

    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    console.error("Erro na rota /scrape:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

