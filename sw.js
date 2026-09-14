const DB_NAME = 'site-folder-preview-v2';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const META_STORE = 'meta';
const VIRTUAL_SEGMENT = '__siteview__';
const RUNTIME_PATH = '__siteview_runtime__.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getRecord(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function cleanPath(path) {
  const parts = [];
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch {}
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}

function mimeFor(path, fallback = '') {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8', txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
    avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', wasm: 'application/wasm',
    map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8'
  };
  return map[ext] || fallback || 'application/octet-stream';
}

function shouldKeepURL(value) {
  const v = String(value || '').trim();
  return !v || v.startsWith('#') || v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v);
}

function rewriteRootURL(value, prefix) {
  if (shouldKeepURL(value)) return value;
  if (value.startsWith('/') && !value.startsWith(prefix)) return `${prefix}${value.slice(1)}`;
  return value;
}

function runtimeScript(prefix) {
  return `(() => {
  'use strict';
  const PREFIX = ${JSON.stringify(prefix)};
  const nativeLocation = window.location;
  const nativeHistory = window.history;
  const URL_ATTRS = new Set(['href','src','action','poster','data']);

  function stripPath(pathname) {
    if (pathname === PREFIX.slice(0, -1)) return '/';
    if (pathname.startsWith(PREFIX)) return '/' + pathname.slice(PREFIX.length);
    return pathname;
  }

  function mapURL(value) {
    if (value == null) return value;
    const raw = String(value);
    if (!raw || raw.startsWith('#') || raw.startsWith('?') || raw.startsWith('//') || /^(?:data|blob|mailto|tel|javascript):/i.test(raw)) return raw;
    if (raw.startsWith(PREFIX)) return raw;
    if (raw.startsWith('/')) return PREFIX + raw.slice(1);
    try {
      const parsed = new URL(raw, nativeLocation.href);
      if (parsed.origin === nativeLocation.origin && !parsed.pathname.startsWith(PREFIX)) {
        parsed.pathname = PREFIX + parsed.pathname.replace(/^\\/+/, '');
        return parsed.href;
      }
    } catch {}
    return raw;
  }

  function publicHref() {
    const url = new URL(nativeLocation.href);
    url.pathname = stripPath(url.pathname);
    return url.href;
  }

  const locationView = {
    get href() { return publicHref(); },
    set href(value) { nativeLocation.href = mapURL(value); },
    get pathname() { return stripPath(nativeLocation.pathname); },
    set pathname(value) { nativeLocation.href = mapURL(String(value) + nativeLocation.search + nativeLocation.hash); },
    get search() { return nativeLocation.search; },
    set search(value) { nativeLocation.search = value; },
    get hash() { return nativeLocation.hash; },
    set hash(value) { nativeLocation.hash = value; },
    get origin() { return nativeLocation.origin; },
    get protocol() { return nativeLocation.protocol; },
    get host() { return nativeLocation.host; },
    get hostname() { return nativeLocation.hostname; },
    get port() { return nativeLocation.port; },
    assign(value) { nativeLocation.assign(mapURL(value)); },
    replace(value) { nativeLocation.replace(mapURL(value)); },
    reload(...args) { nativeLocation.reload(...args); },
    toString() { return publicHref(); },
    valueOf() { return publicHref(); }
  };
  Object.defineProperty(window, '__SITEVIEW__', { value: locationView, configurable: false, enumerable: false });

  for (const method of ['pushState', 'replaceState']) {
    const original = nativeHistory[method].bind(nativeHistory);
    nativeHistory[method] = (state, title, url) => original(state, title, url == null ? url : mapURL(url));
  }

  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = (input, init) => {
      if (typeof input === 'string' || input instanceof URL) return nativeFetch(mapURL(input), init);
      if (input instanceof Request) {
        const mapped = mapURL(input.url);
        if (mapped !== input.url) return nativeFetch(new Request(mapped, input), init);
      }
      return nativeFetch(input, init);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, mapURL(url), ...rest);
  };

  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => nativeBeacon(mapURL(url), data);
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const lower = String(name).toLowerCase();
    if (URL_ATTRS.has(lower) && typeof value === 'string') value = mapURL(value);
    if (lower === 'srcset' && typeof value === 'string') {
      value = value.split(',').map((candidate) => {
        const bits = candidate.trim().split(/\\s+/);
        bits[0] = mapURL(bits[0]);
        return bits.join(' ');
      }).join(', ');
    }
    return nativeSetAttribute.call(this, name, value);
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    const raw = anchor.getAttribute('href');
    if (!raw || raw.startsWith('#')) return;
    const mapped = mapURL(raw);
    if (mapped !== raw) nativeSetAttribute.call(anchor, 'href', mapped);
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const raw = form.getAttribute('action');
    if (!raw) return;
    const mapped = mapURL(raw);
    if (mapped !== raw) nativeSetAttribute.call(form, 'action', mapped);
  }, true);
})();`;
}

function rewriteHTML(html, prefix) {
  html = html.replace(/(<(?:a|link|script|img|source|video|audio|iframe|form|object|embed|input)\b[^>]*?\s(?:href|src|action|poster|data)\s*=\s*)(["'])([^"']*)\2/gi,
    (all, start, quote, value) => `${start}${quote}${rewriteRootURL(value, prefix)}${quote}`);

  html = html.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (all, start, quote, value) => {
    const rewritten = value.split(',').map((candidate) => {
      const bits = candidate.trim().split(/\s+/);
      bits[0] = rewriteRootURL(bits[0], prefix);
      return bits.join(' ');
    }).join(', ');
    return `${start}${quote}${rewritten}${quote}`;
  });

  html = html.replace(/url\(\s*(["']?)\/(?!\/)([^)'"\s]+)\1\s*\)/gi, (all, quote, path) => `url(${quote}${prefix}${path}${quote})`);

  const runtimeTag = `<script src="${prefix}${RUNTIME_PATH}"></script>`;
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${runtimeTag}`);
  else html = `${runtimeTag}\n${html}`;
  return html;
}

function rewriteCSS(css, prefix) {
  return css
    .replace(/url\(\s*(["']?)\/(?!\/)([^)'"\s]+)\1\s*\)/gi, (all, quote, path) => `url(${quote}${prefix}${path}${quote})`)
    .replace(/(@import\s+(?:url\()?\s*["']?)\/(?!\/)/gi, `$1${prefix}`);
}

function rewriteJS(js, prefix) {
  // ESM imports and common network/worker APIs using root-relative literals.
  js = js.replace(/((?:from\s*|import\s*\(\s*|import\s+|export\s+[^;]*?from\s*)["'])\/(?!\/)/g, `$1${prefix}`);
  js = js.replace(/((?:fetch|Worker|SharedWorker|EventSource)\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`);

  // Give hydrated apps a virtual Location object with the preview prefix removed.
  js = js.replace(/\bwindow\.location\b/g, 'window.__SITEVIEW__');
  js = js.replace(/\bdocument\.location\b/g, 'window.__SITEVIEW__');
  js = js.replace(/\bglobalThis\.location\b/g, 'window.__SITEVIEW__');
  return js;
}

async function findProjectFile(fileStore, session, mountRoot, virtualPath) {
  const candidates = [];
  const clean = cleanPath(virtualPath);
  if (!clean) candidates.push('index.html');
  else {
    candidates.push(clean);
    if (clean.endsWith('/')) candidates.push(`${clean}index.html`);
    else if (!/\.[a-z0-9]{1,10}$/i.test(clean)) {
      candidates.push(`${clean}/index.html`);
      candidates.push(`${clean}.html`);
    }
  }

  for (const candidate of candidates) {
    const full = `${mountRoot || ''}${candidate}`;
    const record = await getRecord(fileStore, `${session}:${full}`);
    if (record) return { record, virtualPath: candidate, fallback: false };
  }
  return null;
}

async function serveVirtual(request, parsed) {
  const { session, path, prefix } = parsed;
  const wanted = cleanPath(path);

  if (wanted === RUNTIME_PATH) {
    return new Response(runtimeScript(prefix), {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    });
  }

  const db = await openDB();
  const tx = db.transaction([FILE_STORE, META_STORE], 'readonly');
  const fileStore = tx.objectStore(FILE_STORE);
  const metaStore = tx.objectStore(META_STORE);
  const meta = await getRecord(metaStore, session);
  if (!meta) {
    db.close();
    return new Response('Preview session not found', { status: 404 });
  }

  let found = await findProjectFile(fileStore, session, meta.mountRoot || '', wanted);
  const accept = request.headers.get('accept') || '';
  const isNavigation = request.mode === 'navigate' || accept.includes('text/html');

  if (!found && isNavigation && !/\.[a-z0-9]{1,10}$/i.test(wanted)) {
    const fallbackPath = `${meta.mountRoot || ''}${meta.entry || 'index.html'}`;
    const record = await getRecord(fileStore, `${session}:${fallbackPath}`);
    if (record) found = { record, virtualPath: meta.entry || 'index.html', fallback: true };
  }

  db.close();
  if (!found) {
    return new Response('File not found in local project', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  const type = mimeFor(found.record.path, found.record.type);
  const headers = new Headers({
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });

  if (/text\/html/i.test(type)) {
    let text = await found.record.blob.text();
    text = rewriteHTML(text, prefix);
    return new Response(text, { status: 200, headers });
  }
  if (/text\/css/i.test(type)) {
    let text = await found.record.blob.text();
    text = rewriteCSS(text, prefix);
    return new Response(text, { status: 200, headers });
  }
  if (/javascript/i.test(type)) {
    let text = await found.record.blob.text();
    text = rewriteJS(text, prefix);
    return new Response(text, { status: 200, headers });
  }
  return new Response(found.record.blob, { status: 200, headers });
}

function parseVirtualURL(url) {
  const parsedURL = new URL(url);
  const marker = `/${VIRTUAL_SEGMENT}/`;
  const index = parsedURL.pathname.indexOf(marker);
  if (index < 0) return null;

  const rest = parsedURL.pathname.slice(index + marker.length);
  const slash = rest.indexOf('/');
  const session = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : '';
  if (!session) return null;

  const prefix = `${parsedURL.pathname.slice(0, index + marker.length)}${session}/`;
  return { session, path, prefix };
}

self.addEventListener('fetch', (event) => {
  const parsed = parseVirtualURL(event.request.url);
  if (!parsed) return;
  event.respondWith(serveVirtual(event.request, parsed).catch((error) => new Response(`Preview error: ${error.message}`, {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })));
});
