// server.js - Servicio Express + Playwright para Render
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const TARGET_URL =
  process.env.TARGET_URL ||
  'https://dniperu.com/buscar-dni-por-nombres-y-apellidos/';
const PROXY_URL = process.env.PROXY_URL || ''; // ej: http://user:pass@host:port

// Reutilizar el browser entre requests para performance
let browser;

/**
 * Obtiene/crea una instancia de Chromium para ser reutilizada.
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  return browser;
}

app.get('/healthz', async (_req, res) => {
  res.json({ ok: true, target: TARGET_URL, ts: new Date().toISOString() });
});

/**
 * Endpoint principal de búsqueda.
 * Acepta POST (JSON o form) y GET con query params.
 * Parámetros: nombres, apellido_paterno, apellido_materno
 */
app.all('/api/buscar', async (req, res) => {
  try {
    const input = { ...req.query, ...req.body };
    const nombres = String(input.nombres || '').trim();
    const ap = String(input.apellido_paterno || '').trim();
    const am = String(input.apellido_materno || '').trim();
    const honeypot = String(input.company || '').trim();

    if (honeypot) return res.json({ ok: true, count: 0, items: [] });
    if (!nombres || !ap || !am) {
      return res.status(400).json({ ok: false, error: 'Faltan campos requeridos.' });
    }

    const url = new URL(TARGET_URL);
    url.searchParams.set('nombres', nombres);
    url.searchParams.set('apellido_paterno', ap);
    url.searchParams.set('apellido_materno', am);
    url.searchParams.set('company', '');

    const html = await fetchWithPlaywright(url.toString(), TARGET_URL);
    if (!html) {
      return res.status(502).json({
        ok: false,
        error: 'No se pudo obtener el contenido (bloqueo o error remoto).'
      });
    }

    if (isCloudflareBlock(html)) {
      return res.status(429).json({
        ok: false,
        error: 'Bloqueo anti-bot detectado por Cloudflare. Intenta de nuevo más tarde o usa un proxy diferente.'
      });
    }

    const items = extractResults(html, TARGET_URL);
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error('Error /api/buscar:', e);
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor.'
    });
  }
});

/**
 * Usa Playwright para cargar la página y devolver el HTML renderizado.
 */
async function fetchWithPlaywright(target, referer) {
  const br = await getBrowser();
  const context = await br.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-ES',
    javaScriptEnabled: true,
    proxy: PROXY_URL ? { server: PROXY_URL } : undefined,
    extraHTTPHeaders: {
      'Accept-Language': 'es-ES,es;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-CH-UA-Platform': '"Windows"',
      Referer: referer
    }
  });

  // Reducir carga bloqueando recursos pesados
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  try {
    // Navegar y esperar a que se asiente el DOM
    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Si el sitio usa navegación posterior o render JS, esperar un poco adicional
    // e intentar detectar resultados (tablas o bloques)
    await waitForResultsHeuristic(page, 12000);

    const content = await page.content();
    return content;
  } catch (err) {
    console.error('fetchWithPlaywright error:', err.message || err);
    return null;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * Espera heurística: o aparece una tabla/lista o pasa un pequeño delay.
 */
async function waitForResultsHeuristic(page, extraMs = 8000) {
  try {
    await Promise.race([
      page.waitForSelector('table, .results, article, ul, ol, [class*=result], [class*=resultado], [class*=search]', {
        timeout: extraMs
      }),
      page.waitForTimeout(extraMs)
    ]);
  } catch {
    // ignorar
  }
}

function isCloudflareBlock(html) {
  return /cf-browser-verification|cloudflare|attention required|please enable javascript/i.test(html || '');
}

/**
: Intenta extraer resultados del HTML con varias heurísticas.
: Devuelve objetos { dni, nombreCompleto, enlace, extra? }
 */
function extractResults(html, baseUrl) {
  const $ = cheerio.load(html);
  const results = [];
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // Heurística 1: Tablas con cabeceras significativas
  $('table').each((_, table) => {
    const $table = $(table);
    const headers = [];
    $table.find('thead tr th, tr:first-child th, tr:first-child td').each((_, th) => {
      headers.push(norm($(th).text()).toLowerCase());
    });
    if (!headers.length) return;

    const idxDni = headers.findIndex((h) => /dni/.test(h));
    const idxNom = headers.findIndex((h) => /(nombre|nombres|nombre completo)/.test(h));
    const idxApePat = headers.findIndex((h) => /paterno/.test(h));
    const idxApeMat = headers.findIndex((h) => /materno/.test(h));
    if (idxDni === -1 && idxNom === -1 && idxApePat === -1 && idxApeMat === -1) return;

    $table.find('tbody tr, tr').each((i, tr) => {
      if (i === 0 && $table.find('thead').length === 0) return;
      const tds = $(tr).find('td');
      if (!tds.length) return;

      const get = (idx) => (idx >= 0 ? norm($(tds[idx]).text()) : '');
      const dni = get(idxDni) || findDniInText($(tr).text());
      let nombreCompleto = '';
      if (idxNom >= 0) nombreCompleto = get(idxNom);
      else nombreCompleto = [get(idxApePat), get(idxApeMat)].filter(Boolean).join(' ');

      const enlace =
        $(tr).find('a[href]').attr('href') ||
        ($(tds[idxNom >= 0 ? idxNom : 0]).find('a').attr('href') || '');

      if (dni || nombreCompleto || enlace) {
        results.push({
          dni: dni || null,
          nombreCompleto: nombreCompleto || null,
          enlace: absolutizeUrl(enlace, baseUrl) || null,
          extra: norm($(tr).text())
        });
      }
    });
  });

  // Heurística 2: Bloques por clase
  if (results.length === 0) {
    $('[class*=result], [class*=resultado], [class*=search], article, ul, ol]')
      .slice(0, 12)
      .each((_, el) => {
        const blockText = norm($(el).text());
        const dni = findDniInText(blockText);
        if (!dni) return;

        const nombreMatch = blockText
          .replace(/\s+/g, ' ')
          .match(new RegExp(String(dni) + '\\D+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ\\s]{3,80})'));
        const nombre = nombreMatch ? norm(nombreMatch[1]) : null;
        const enlace = absolutizeUrl($(el).find('a[href]').attr('href'), baseUrl);

        results.push({
          dni,
          nombreCompleto: nombre,
          enlace: enlace || null,
          extra: blockText.slice(0, 240)
        });
      });
  }

  // Heurística 3: DNIs sueltos
  if (results.length === 0) {
    const text = norm($('body').text());
    const dnis = Array.from(new Set((text.match(/\b\d{8}\b/g) || []).slice(0, 25)));
    dnis.forEach((dni) => results.push({ dni, nombreCompleto: null, enlace: null, extra: null }));
  }

  // Deduplicar
  const seen = new Set();
  return results.filter((r) => {
    const key = `${r.dni || ''}|${r.nombreCompleto || ''}|${r.enlace || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findDniInText(text) {
  const m = String(text || '').match(/\b\d{8}\b/);
  return m ? m[0] : null;
}

function absolutizeUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Target: ${TARGET_URL}`);
});