const DB_NAME = 'site-folder-preview-v1';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const META_STORE = 'meta';
const VIRTUAL_SEGMENT = '__siteview__';

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
  for (const part of decodeURIComponent(path).split('/')) {
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
    map: 'application/json; charset=utf-8'
  };
  return map[ext] || fallback || 'application/octet-stream';
}

function shouldKeepURL(value) {
  const v = value.trim();
  return !v || v.startsWith('#') || v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v);
}

function rewriteRootURL(value, prefix) {
  if (shouldKeepURL(value)) return value;
  if (value.startsWith('/')) return `${prefix}${value.slice(1)}`;
  return value;
}

function rewriteHTML(html, prefix, currentPath) {
  const pageDir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const baseHref = `${prefix}${pageDir}`;

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

  html = html.replace(/url\(\s*(["']?)\/(?!\/)([^)'"\s]+)\1\s*\)/gi, (all, q, path) => `url(${q}${prefix}${path}${q})`);

  const baseTag = `<base href="${baseHref}">`;
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${baseTag}`);
  else html = `${baseTag}\n${html}`;
  return html;
}

function rewriteCSS(css, prefix) {
  return css
    .replace(/url\(\s*(["']?)\/(?!\/)([^)'"\s]+)\1\s*\)/gi, (all, q, path) => `url(${q}${prefix}${path}${q})`)
    .replace(/(@import\s+(?:url\()?\s*["']?)\/(?!\/)/gi, `$1${prefix}`);
}

function rewriteJS(js, prefix) {
  // Conservative support for common built/static module patterns. We do not attempt to compile source projects.
  js = js.replace(/((?:from\s*|import\s*\(\s*|import\s+|export\s+[^;]*?from\s*)["'])\/(?!\/)/g, `$1${prefix}`);
  js = js.replace(/((?:fetch|Worker|SharedWorker)\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`);
  return js;
}

async function serveVirtual(request, parsed) {
  const { session, path, prefix } = parsed;
  const db = await openDB();
  const tx = db.transaction([FILE_STORE, META_STORE], 'readonly');
  const fileStore = tx.objectStore(FILE_STORE);
  const metaStore = tx.objectStore(META_STORE);
  const meta = await getRecord(metaStore, session);
  if (!meta) { db.close(); return new Response('Preview session not found', { status: 404 }); }

  let wanted = cleanPath(path);
  if (!wanted) wanted = meta.entry || 'index.html';
  let record = await getRecord(fileStore, `${session}:${wanted}`);

  if (!record && !wanted.endsWith('/')) record = await getRecord(fileStore, `${session}:${wanted}/index.html`);
  if (!record && wanted.endsWith('/')) record = await getRecord(fileStore, `${session}:${wanted}index.html`);

  const accept = request.headers.get('accept') || '';
  const isNavigation = request.mode === 'navigate' || accept.includes('text/html');
  if (!record && isNavigation && !/\.[a-z0-9]{1,8}$/i.test(wanted)) {
    record = await getRecord(fileStore, `${session}:${meta.entry || 'index.html'}`);
    wanted = meta.entry || 'index.html';
  }

  db.close();
  if (!record) return new Response('File not found in local project', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const type = mimeFor(record.path, record.type);
  const headers = new Headers({
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });

  if (/text\/html/i.test(type)) {
    let text = await record.blob.text();
    text = rewriteHTML(text, prefix, record.path);
    return new Response(text, { status: 200, headers });
  }
  if (/text\/css/i.test(type)) {
    let text = await record.blob.text();
    text = rewriteCSS(text, prefix);
    return new Response(text, { status: 200, headers });
  }
  if (/javascript/i.test(type)) {
    let text = await record.blob.text();
    text = rewriteJS(text, prefix);
    return new Response(text, { status: 200, headers });
  }
  return new Response(record.blob, { status: 200, headers });
}

function parseVirtualURL(url) {
  const u = new URL(url);
  const marker = `/${VIRTUAL_SEGMENT}/`;
  const idx = u.pathname.indexOf(marker);
  if (idx < 0) return null;
  const rest = u.pathname.slice(idx + marker.length);
  const slash = rest.indexOf('/');
  const session = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : '';
  if (!session) return null;
  const prefix = `${u.pathname.slice(0, idx + marker.length)}${session}/`;
  return { session, path, prefix };
}

self.addEventListener('fetch', (event) => {
  const parsed = parseVirtualURL(event.request.url);
  if (!parsed) return;
  event.respondWith(serveVirtual(event.request, parsed).catch((error) => new Response(`Preview error: ${error.message}`, {
    status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }
  })));
});
