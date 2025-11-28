// index.js - scraper completo com nova lógica de preço e Busca Integrada (Mercado Livre + Google)
// Versão final: Correção do bug de divisão por 100 (cent heuristic) para grandes valores.
// UPDATE: Adicionado User-Agent na requisição do Mercado Livre para evitar bloqueio.

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import PQueue from "p-queue";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import * as cheerio from "cheerio";

puppeteer.use(StealthPlugin());

const app = express();

// evita ValidationError do express-rate-limit com X-Forwarded-For
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const limiter = rateLimit({ windowMs: 10 * 1000, max: 30 });
app.use(limiter);

// CORREÇÃO DE NOME DE VAR: Manter SCRAPE_CONCURRENCY, mas notar que no render.yaml o nome pode estar errado.
const queue = new PQueue({ concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 2 });

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------- LÓGICA DE BUSCA (NOVO) ----------------

// 1. API Oficial do Mercado Livre (Garantida e Rápida) - VERSÃO CORRIGIDA
async function searchMercadoLivre(query) {
  try {
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=10`;
    
    // Headers mais completos para simular navegador real
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    };

    const response = await axios.get(url, { 
      headers,
      timeout: 10000 // 10 segundos timeout
    });
    
    if (!response.data || !response.data.results) {
      console.log('Resposta vazia do Mercado Livre');
      return [];
    }
    
    return response.data.results.map(item => ({
      title: item.title,
      price: item.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      store: 'Mercado Livre',
      imageUrl: item.thumbnail ? item.thumbnail.replace('I.jpg', 'W.jpg') : '',
      link: item.permalink
    }));
  } catch (error) {
    console.error('Erro detalhado no ML:', {
      message: error.message,
      response: error.response?.status,
      data: error.response?.data
    });
    
    // Fallback: tentar via scraping se a API falhar
    return await searchMercadoLivreFallback(query);
  }
}

// Fallback via scraping caso a API oficial falhe
async function searchMercadoLivreFallback(query) {
  try {
    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
    };

    const response = await axios.get(searchUrl, { headers, timeout: 15000 });
    const $ = cheerio.load(response.data);
    const results = [];

    $('.ui-search-result__wrapper').slice(0, 10).each((i, el) => {
      const title = $(el).find('.ui-search-item__title').text().trim();
      const price = $(el).find('.andes-money-amount__fraction').first().text().trim();
      const imageUrl = $(el).find('.ui-search-result-image__element').attr('src') || $(el).find('.ui-search-result-image__element').attr('data-src');
      const link = $(el).find('.ui-search-link').attr('href');

      if (title && price) {
        results.push({
          title,
          price: `R$ ${price}`,
          store: 'Mercado Livre',
          imageUrl: imageUrl || '',
          link: link || ''
        });
      }
    });

    return results;
  } catch (fallbackError) {
    console.error('Fallback também falhou:', fallbackError.message);
    return [];
  }
}

// 2. Scraping Google Shopping (Complementar)
async function searchGoogleShopping(query) {
  try {
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=shop&hl=pt-BR&gl=br`;
    const response = await axios.get(url, { headers });
    
    const $ = cheerio.load(response.data);
    const results = [];

    $('.i0X6df, .sh-dgr__content').each((i, el) => {
      if (results.length >= 8) return; 

      const title = $(el).find('h3, .tAxDx').text().trim();
      let price = $(el).find('.a8Pemb, .aSection').first().text().trim();
      if (!price) price = $(el).find('span[aria-hidden="true"]').first().text().trim();
      let store = $(el).find('.aULzUe, .IuHnof').text().trim();
      let imageUrl = $(el).find('img').attr('src');
      let link = $(el).find('a').attr('href');

      if (link && link.startsWith('/url?q=')) {
        link = link.split('/url?q=')[1].split('&')[0];
      } else if (link && link.startsWith('/')) {
        link = 'https://www.google.com' + link;
      }

      if (title && price && imageUrl) {
        results.push({
          title,
          price: price.includes('R$') ? price : `R$ ${price}`,
          store: store || 'Loja Online',
          imageUrl,
          link
        });
      }
    });

    return results;
  } catch (error) {
    console.error('Erro no Google Scraping:', error.message);
    return [];
  }
}

// ---------------- helpers (ORIGINAL) ----------------

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

// ---------------- XHR collector (CORRIGIDO: Mais rigoroso com chaves) ----------------
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
                                // Lógica de parcelamento mantida
                                prices.push({ raw: text, source: "xhr", isInstallment: true, parcelCount: Number(inst[1]), parcelValueRaw: inst[2], url });
                                prices.push({ raw: `computed_installment_total:${inst[1]}x${inst[2]}`, source: "xhr", computedFrom: { count: Number(inst[1]), rawValue: inst[2] }, url });
                            } else {
                                // CORREÇÃO: Apenas keys explicitamente de preço
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

// ---------------- parsing helpers ----------------
function parseNumberFromString(raw) {
    if (raw === null || raw === undefined) return { num: null, note: "empty" };
    let s = String(raw).trim();
    if (!s) return { num: null, note: "empty" };

    s = s.replace(/\u00A0/g, ""); // NBSP
    s = s.replace(/(R\$|BRL|\$)/gi, "");

    // remove non numeric except . and ,
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

    // CORREÇÃO CRÍTICA: Se o número resultante (t) já contém um ponto decimal,
    // ele foi formatado corretamente (ex: 140235.30) e a heurística não deve ser aplicada.
    const digitsOnly = t.replace(".", "");
    const hasDecimalPoint = t.includes('.');

    // Heurística: long integer without separators likely centavos -> apply conservatively
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

// ---------------- NEW: busca preço próximo ao CTA (botão comprar) ----------------
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

// ---------------- FINAL PRICE SELECTION ----------------
function selectBestPrice(candidatesWithMeta, proximityMap = {}, debug) {
    // debug is an object we push traces into
    if (!Array.isArray(candidatesWithMeta) || candidatesWithMeta.length === 0) {
        debug.reason = "no_candidates";
        return null;
    }

    // copy and augment
    const augmented = candidatesWithMeta.slice();

    // ---------- pairings and computed totals ----------
    // detect standalone numbers and pair to price-per-installment candidates to create computed totals
    const standaloneNumbers = augmented
        .map(c => ({ c, raw: String(c.raw || "").trim() }))
        .filter(x => /^\d{1,3}$/.test(x.raw))
        .map(x => Number(x.raw));

    // add computed totals for explicit "Nx R$ V" already present
    for (const p of augmented.slice()) {
        const inst = detectInstallmentFromString(String(p.raw || ""));
        if (inst && inst.total) {
            augmented.push({ raw: `computed_installment_total:${inst.count}x${inst.parcelValue}`, source: p.source || "detected", computedTotal: true, from: p.raw });
        }
    }

    // pair standalone numbers with R$ values (if makes sense)
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

    // ---------- normalized processing ----------
    const processed = [];
    for (const c of augmented) {
        const raw = String(c.raw || "").trim();
        if (!raw) continue;

        // computed markers
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

        // inline installment detection
        const inst = detectInstallmentFromString(raw);
        if (inst && inst.total) {
            processed.push({ raw, source: c.source || "mixed", num: inst.total, computedTotal: true, note: "detected-installment" });
            processed.push({ raw: raw + "_per", source: c.source || "mixed", num: inst.parcelValue, isParcel: true, parcelCount: inst.count });
            debug.trace && debug.trace.push({ action: "installment_detected", raw, parsed: inst });
            continue;
        }

        // parse normally
        const p = parseNumberFromString(raw);
        if (p.num) {
            processed.push({ raw, source: c.source || "unknown", num: p.num, isParcel: false, note: p.note, extra: c });
            continue;
        }

        // fallback numeric-only
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
            // Captura o campo original se vier do XHR para penalizar/bonificar List/Sale
            const field = String(p.extra?.field || "").toLowerCase();

            // Pontuação baseada na fonte (Aumentada para as fontes mais confiáveis)
            if (src.includes("jsonld")) score += 80;
            // Aumentei o peso do Selector (agora +60)
            else if (src.includes("selector")) score += 60;
            // Diminuí o peso do NearCTA (agora +35)
            else if (src.includes("nearCTA")) score += 35;
            else if (src.includes("xhr")) score += 20;
            else if (src.includes("body")) score += 5;
            else score += 5;

            // Redução do boost para Computed Totals (apenas +5)
            if (p.computedTotal) score += 5;

            // Penalidade para o valor da parcela isolada
            if (p.isParcel) score -= 50;

            // Penalizar "List Price" (Preço "De") e bonificar "Sale Price" (Preço "Por")
            if (field.includes("original") || field.includes("old") || field.includes("from")) {
                score -= 30; // Penaliza preço antigo
            }
            if (field.includes("sale") || field.includes("best") || field.includes("offer") || field.includes("current")) {
                score += 20; // Bonifica preço atual de venda
            }

            // Moeda explícita (R$)
            if (/R\$/i.test(p.raw)) score += 15;

            // Frequência (Limitada)
            const f = freq[Number(p.num).toFixed(2)] || 0;
            score += Math.min(f, 5) * 6;

            // Proximidade
            try {
                const prox = proximityMap[p.raw];
                if (prox) {
                    if (prox.near) score += 30;
                    score += Math.min(prox.count || 0, 5) * 2;
                }
            } catch (e) { }

            // Penalidades severas
            if (p.likelyId) score -= 90;
            if (p.num < 5) score -= 30;
            if (p.num > 1000000) score -= 100;

            // Heurísticas de Relação (median/max)
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

    // safety: if best comes from cent heuristic but there's explicit R$ candidate, prefer explicit
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

// ---------------- main scraper ----------------
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
                // --- CORREÇÃO 1: Adicionar seletores de preço "original" e tachado (Crucial para Farfetch) ---
                "s", "del", // tags de tachado (list price)
                ".list-price", ".original-price", ".price--original", ".old-price", ".priceBox__from" // classes comuns de preço original
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

            // body fallback - captures parcelamentos
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

            // dedupe preserving first source
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

            // Build the response including debug detail
            return {
                success: true,
                url: cleaned,
                title: title || null,
                price: finalPrice || null,
                image: image || null,
                rawCandidatesCount: dedup.length,
                debug // full debug object
            };
        } catch (err) {
            await browser.close().catch(() => { });
            console.error("SCRAPER ERROR:", err && (err.message || err));
            debug.error = String(err);
            return { success: false, error: String(err), debug };
        }
    });
}

// ---------------- routes ----------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/scrape", async (req, res) => {
    try {
        const url = req.body?.url || req.query?.url;
        
        // Verifica se é uma URL (Scraping direto com Puppeteer)
        const isUrl = url && (url.startsWith('http://') || url.startsWith('https://'));

        if (isUrl) {
            console.log(`Scraping individual para: ${url}`);
            const result = await scrapeProduct(url);
            res.json(result);
        } else {
            // Se NÃO for URL, assume que é uma BUSCA (Google Shopping + ML)
            console.log(`Realizando busca para: ${url}`);
            
            if (!url || url.trim().length < 2) {
                return res.json([]);
            }

            const [mlResults, googleResults] = await Promise.all([
                searchMercadoLivre(url),
                searchGoogleShopping(url)
            ]);

            // Intercala os resultados
            const combined = [];
            const maxLength = Math.max(mlResults.length, googleResults.length);
            
            for (let i = 0; i < maxLength; i++) {
                if (mlResults[i]) combined.push(mlResults[i]);
                if (googleResults[i]) combined.push(googleResults[i]);
            }
            
            res.json(combined);
        }

    } catch (e) {
        console.error("ROUTE ERROR:", e && e.message);
        res.status(500).json({ success: false, error: String(e) });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
