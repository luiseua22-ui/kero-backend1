import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

const queue = new PQueue({ concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2 });

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// -------------------------------------------------------------
function sanitizeIncomingUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();

  const matches = [...s.matchAll(/https?:\/\/[^\s"']+/gi)].map((m) => m[0]);
  if (matches.length > 0) return matches[0];

  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  try {
    return new URL(s).toString();
  } catch (e) {
    return null;
  }
}

// -------------------------------------------------------------
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
      }, 130);
    });
  }, maxScroll);
}

// -------------------------------------------------------------
async function querySelectorShadow(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      try {
        if (root.querySelector) {
          const found = root.querySelector(sel);
          if (found) return found;
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
        for (const n of nodes) {
          if (n.shadowRoot) {
            const r = search(n.shadowRoot);
            if (r) return r;
          }
        }
      } catch (e) {}
      return null;
    }

    const el = search(document);
    if (!el) return null;

    if (el.tagName === "IMG") return { type: "img", src: el.src || el.currentSrc || null };
    if (el.tagName === "META") return { type: "meta", content: el.content || null };

    return { type: "other", text: (el.innerText || el.textContent || "").trim() || null };
  }, selector);
}

// -------------------------------------------------------------
function createXHRPriceCollector(page) {
  const prices = [];

  page.on("response", async (resp) => {
    try {
      const url = resp.url().toLowerCase();
      if (
        url.includes("price") ||
        url.includes("offer") ||
        url.includes("sku") ||
        url.includes("product") ||
        url.includes("pricing")
      ) {
        const ctype = resp.headers()["content-type"] || "";
        if (!ctype.includes("application/json")) return;

        const json = await resp.json().catch(() => null);
        if (!json) return;

        const candidates = [];

        const walk = (o) => {
          if (!o || typeof o !== "object") return;
          for (const k in o) {
            const v = o[k];

            if (
              k.toLowerCase().includes("price") ||
              k.toLowerCase().includes("amount") ||
              k.toLowerCase().includes("value")
            ) {
              if (typeof v === "string" || typeof v === "number") {
                candidates.push(String(v));
              }
            }

            if (typeof v === "object") walk(v);
          }
        };

        walk(json);

        candidates.forEach((p) => prices.push(p));
      }
    } catch (e) {}
  });

  return () => prices;
}

// -------------------------------------------------------------
// NORMALIZAÇÃO ROBUSTA DE PREÇOS
function normalizePrice(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();

  if (!s) return null;

  // se JSON numérico (ex: 590400 ou 5904)
  if (/^\d+$/.test(s)) {
    // número inteiro puro: pode ser cents (590400) ou reais (5904)
    const asInt = Number(s);
    if (asInt > 10000) {
      // tenta interpretar como centavos (divide por 100) se isso produzir valor plausível
      return asInt / 100;
    }
    return asInt;
  }

  // remover rótulos de moeda e espaços estranhos
  s = s.replace(/\u00A0/g, " "); // nbsp
  s = s.replace(/(r\$\s?)/i, "");
  s = s.replace(/(brl)/i, "");
  s = s.replace(/[^\d.,]/g, ""); // deixar apenas dígitos e separadores

  if (!s) return null;

  // captura padrão com agrupamentos: exemplo "1.234,56" ou "5,904.00" ou "5904,00"
  const candidate = s.match(/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?$/);
  const rawHasBoth = s.indexOf(",") !== -1 && s.indexOf(".") !== -1;

  let normalized = null;

  if (candidate) {
    // decidir qual separador é decimal: o último separator provavelmente é decimal
    if (rawHasBoth) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma > lastDot) {
        // ',' decimal, '.' milhares
        normalized = s.replace(/\./g, "").replace(",", ".");
      } else {
        // '.' decimal, ',' milhares
        normalized = s.replace(/,/g, "");
      }
    } else if (s.indexOf(",") !== -1 && s.indexOf(".") === -1) {
      // só vírgula presente: assume vírgula decimal se parte após vírgula tem 1-2 dígitos,
      // ou milhares se o grupo antes contém separadores esperados.
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        normalized = s.replace(/\./g, "").replace(",", ".");
      } else {
        // caso raro: "1,000" pode ser 1000 ou 1.00; assumimos milhares -> remove vírgulas
        normalized = s.replace(/,/g, "");
      }
    } else if (s.indexOf(".") !== -1 && s.indexOf(",") === -1) {
      // só ponto presente: se parte após ponto tem 2 dígitos assumimos decimal, senão milhares
      const parts = s.split(".");
      if (parts.length === 2 && parts[1].length === 2) {
        normalized = s.replace(/,/g, "");
      } else {
        // ex: "5.904" possivelmente 5904 (thousand separator) — removemos pontos
        normalized = s.replace(/\./g, "");
      }
    } else {
      normalized = s;
    }
  } else {
    // padrão simples: retirar tudo que não é número, vírgula ou ponto
    normalized = s.replace(/[^\d.,]/g, "");
  }

  if (!normalized) return null;

  // agora substituir vírgula por ponto se houver vírgula decimal
  // normalizing: already replaced thousands. Ensure only one dot decimal separator
  const dots = (normalized.match(/\./g) || []).length;
  const commas = (normalized.match(/,/g) || []).length;

  // if both present after previous logic, fallback: take last separator as decimal
  if (dots > 1 && commas === 0) {
    // remove all dots except last two digits decimal pattern
    // fallback: remove all dots
    normalized = normalized.replace(/\./g, "");
  }

  // finally unify to dot decimal
  normalized = normalized.replace(",", ".");

  // parse
  const num = Number(normalized);
  if (isNaN(num)) return null;

  // Heurística para valores em centavos vindos como inteiro enorme (ex: 590400 -> 5904)
  if (num > 100000 && Number.isInteger(num)) {
    // tenta dividir por 100 se isso produzir um valor razoável comparado ao próprio
    const maybe = num / 100;
    if (maybe < num && maybe > 0) return maybe;
  }

  return num;
}

// -------------------------------------------------------------
// finalizePrice com suporte a proximityMap e heurísticas extras
function finalizePrice(allValues, proximityMap = {}) {
  if (!Array.isArray(allValues) || allValues.length === 0) return null;

  // montar candidatos com origem e contagem aproximada
  const rawList = allValues.map((v) => (v == null ? "" : String(v).trim())).filter(Boolean);

  // debug log
  console.log("RAW PRICES (entrada):", rawList);

  const candidates = rawList
    .map((raw) => {
      const num = normalizePrice(raw);
      return { raw, num };
    })
    .filter((c) => c.num !== null);

  if (candidates.length === 0) {
    console.log("FINALIZE: nenhum candidato numérico válido encontrado.");
    return null;
  }

  // adicionar possíveis ajustes: se um candidato parece centavos inteiros (ex: 590400) já tratado no normalizePrice,
  // mas para robustez, também adicionamos versões ajustadas (num/100) se isso produzir números plausíveis.
  const extended = [];
  for (const c of candidates) {
    extended.push(c);
    if (c.num > 1000 && Number.isInteger(c.num)) {
      const divided = c.num / 100;
      if (divided > 0 && divided < c.num) {
        extended.push({ raw: c.raw + " (ajuste/100)", num: divided });
      }
    }
  }

  // frequency map by normalized numeric string (to boost repeated values)
  const freq = {};
  for (const c of extended) {
    const key = c.num.toFixed(2);
    freq[key] = (freq[key] || 0) + 1;
  }

  // compute median to know scale
  const nums = Array.from(new Set(extended.map((c) => c.num))).sort((a, b) => a - b);
  const median = nums.length % 2 === 1 ? nums[(nums.length - 1) / 2] : (nums[nums.length/2 -1] + nums[nums.length/2]) / 2;

  // scoring
  const scoreFor = (c) => {
    let score = 0;
    const raw = c.raw.toLowerCase();

    // presence of currency symbol or explicit 'r$' is strong
    if (/\br\$/.test(raw) || /\bbrl\b/.test(raw)) score += 10;

    // if raw contains words like 'preço', 'à vista', 'oferta' small boost
    if (/\b(preço|preco|à vista|a vista|vista|oferta|desconto|promo)\b/.test(raw)) score += 3;

    // format: thousands + cents (1.234,56) strong
    if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(c.raw)) score += 6;

    // if has cents (.,xx or ,xx)
    if (/[,\.]\d{2}$/.test(c.raw)) score += 4;

    // penalize explicit installments or strings with 'parcela'
    if (/parcela|parcelas|installment|juros/.test(raw)) score -= 5;

    // penalize long digit-only strings (likely IDs)
    const digitsOnly = c.raw.replace(/[^\d]/g, "");
    if (/^\d{6,}$/.test(digitsOnly) && !/[.,]/.test(c.raw)) score -= 8;

    // frequency helps
    const f = freq[c.num.toFixed(2)] || 0;
    score += Math.min(f, 5) * 2;

    // proximity boost (near title/image)
    const prox = proximityMap[c.raw];
    if (prox) {
      if (prox.near) score += 12;
      score += Math.min(prox.count || 0, 5) * 1.5;
    }

    // scale coherence: if candidate is close to median add small score
    if (median && median > 0) {
      const ratio = c.num / median;
      // prefer candidates within 0.2x - 5x of median
      if (ratio >= 0.2 && ratio <= 5) score += 2;
      // if candidate enormously smaller than median, penalize a bit (likely parcel or ID)
      if (ratio < 0.05) score -= 6;
    }

    // small numbers (<1) penalize lightly
    if (c.num < 1) score -= 4;

    return score;
  };

  const scored = extended.map((c) => ({ ...c, score: scoreFor(c) }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = freq[a.num.toFixed(2)] || 0;
    const fb = freq[b.num.toFixed(2)] || 0;
    if (fb !== fa) return fb - fa;
    return a.num - b.num;
  });

  console.log("CANDIDATES SCORED:", scored.slice(0, 10));

  const best = scored[0];
  if (!best) return null;

  const final = best.num;
  return `R$ ${final.toFixed(2).replace(".", ",")}`;
}

// -------------------------------------------------------------
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

      const collectXHR = createXHRPriceCollector(page);

      // NAVIGATION --------------------------------------------------------------------
      try {
        await page.goto(cleaned, { waitUntil: "networkidle2", timeout: 60000 });
      } catch {
        await page.goto(cleaned, { waitUntil: "domcontentloaded", timeout: 90000 });
      }

      await page.waitForTimeout(700);
      await autoScroll(page);
      await page.waitForTimeout(600);

      // SCRAPING ----------------------------------------------------------------------
      let title = null;
      let image = null;
      let rawPrices = [];

      // JSON-LD
      try {
        const blocks = await page.$$eval(
          'script[type="application/ld+json"]',
          (nodes) => nodes.map((n) => n.textContent)
        );

        for (const block of blocks) {
          try {
            const parsed = JSON.parse(block);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const item of arr) {
              if (!title && (item.name || item.title)) title = item.name || item.title;

              if (!image && item.image) {
                const img = Array.isArray(item.image) ? item.image[0] : item.image;
                image = typeof img === "object" ? img.url || img.contentUrl : img;
              }

              if (item.offers) {
                const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                for (const o of offers) {
                  if (o.price) rawPrices.push(o.price);
                }
              }
            }
          } catch {}
        }
      } catch {}

      // OG ---------------------------------------------
      if (!title)
        title = await page.$eval(`meta[property="og:title"]`, (e) => e.content).catch(() => null);

      if (!image)
        image = await page.$eval(`meta[property="og:image"]`, (e) => e.content).catch(() => null);

      // TÍTULO e IMAGEM fallback ------------------------
      if (!title) {
        title = await page.evaluate(() => {
          const sels = ["h1", ".product-title", ".product-name", ".pdp-title"];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return (el.innerText || el.textContent).trim();
          }
          return null;
        });
      }

      if (!image) {
        const imgs = [
          "img#product-image",
          ".product-image img",
          ".pdp-image img",
          ".gallery img",
          ".image img",
        ];

        for (const sel of imgs) {
          const src = await page.$eval(sel, (el) => el.currentSrc || el.src).catch(() => null);
          if (src) {
            image = src;
            break;
          }
        }
      }

      // PREÇOS HTML -------------------------------------
      const htmlSelectors = [
        "[itemprop='price']",
        ".price",
        ".product-price",
        ".sales-price",
        ".best-price",
        ".valor",
        ".priceFinal",
        ".productPrice",
        ".price--main",
        ".product-price-amount",
      ];

      for (const sel of htmlSelectors) {
        const txt = await page.$eval(sel, (el) => el.innerText || el.textContent || el.content).catch(
          () => null
        );
        if (txt) rawPrices.push(txt);

        const shadow = await querySelectorShadow(page, sel);
        if (shadow?.text) rawPrices.push(shadow.text);
      }

      // PREÇOS XHR ----------------------------------------
      const xhrPrices = collectXHR();
      rawPrices.push(...xhrPrices);

      // FALLBACK TEXTO ------------------------------------
      if (rawPrices.length === 0) {
        const text = await page.evaluate(() => document.body.innerText);
        const m = text.match(/R\$\s?[\d\.,]+/g);
        if (m) rawPrices.push(...m);
      }

      console.log("RAW PRICES COLETADOS:", rawPrices.slice(0, 80));

      // ====== NOVO: análise de proximidade no DOM para cada candidato ======
      const uniqueCandidates = Array.from(new Set(rawPrices.map((r) => (r == null ? "" : String(r).trim()))));

      const proximityInfo = await page.evaluate(
        (candidates, titleText, imageUrl) => {
          const info = {};
          candidates.forEach((c) => {
            info[c] = { near: false, count: 0 };
          });

          const titleEls = [];
          if (titleText && titleText.trim().length > 0) {
            const possible = Array.from(document.querySelectorAll("h1, .product-title, .product-name, .pdp-title"));
            for (const el of possible) {
              try {
                if ((el.innerText || el.textContent || "").trim().includes(titleText.trim())) titleEls.push(el);
              } catch (e) {}
            }
          }

          const imageEls = [];
          if (imageUrl && imageUrl.trim().length > 0) {
            const imgs = Array.from(document.querySelectorAll("img"));
            for (const im of imgs) {
              try {
                const src = im.currentSrc || im.src || "";
                if (src && src.includes(imageUrl)) imageEls.push(im);
              } catch (e) {}
            }
          }

          const contextEls = [...titleEls, ...imageEls];

          function nearEachOther(node, ctxs, maxDepth = 6) {
            if (!node || !ctxs || ctxs.length === 0) return false;
            for (const ctx of ctxs) {
              if (ctx.contains(node) || node.contains(ctx)) return true;
              let a = node;
              for (let i = 0; i < maxDepth && a; i++) {
                if (a === ctx) return true;
                a = a.parentElement;
              }
              a = ctx;
              for (let i = 0; i < maxDepth && a; i++) {
                if (a === node) return true;
                a = a.parentElement;
              }
            }
            return false;
          }

          for (const cand of candidates) {
            if (!cand || cand.trim().length === 0) continue;
            const nodes = Array.from(document.querySelectorAll("body *")).filter((n) => {
              try {
                const t = (n.innerText || n.textContent || "");
                return t && t.includes(cand);
              } catch (e) { return false; }
            });
            info[cand].count = nodes.length;
            if (contextEls.length === 0) continue;
            for (const n of nodes) {
              if (nearEachOther(n, contextEls, 6)) {
                info[cand].near = true;
                break;
              }
            }
          }

          return info;
        },
        uniqueCandidates,
        title || "",
        image || ""
      );

      // FINALIZAÇÃO UNIVERSAL (com proximityInfo)
      const finalPrice = finalizePrice(rawPrices, proximityInfo);

      if (title && typeof title === "string")
        title = title.split("|")[0].split("-")[0].trim();

      await browser.close();

      return {
        success: true,
        url: cleaned,
        title: title || null,
        price: finalPrice || null,
        image: image || null,
      };
    } catch (err) {
      await browser.close().catch(() => {});
      return { success: false, error: err.message };
    }
  });
}

// -------------------------------------------------------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, error: "URL ausente" });

    const result = await scrapeProduct(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// -------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

