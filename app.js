const DB_NAME = 'site-folder-preview-v2';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const META_STORE = 'meta';
const VIRTUAL_SEGMENT = '__siteview__';

const $ = (selector) => document.querySelector(selector);
const els = {
  emptyState: $('#emptyState'), workspace: $('#workspace'), dropZone: $('#dropZone'),
  pickFolder: $('#pickFolder'), folderInput: $('#folderInput'), projectName: $('#projectName'),
  projectMeta: $('#projectMeta'), previewFrame: $('#previewFrame'), addressBar: $('#addressBar'),
  statusDot: $('#statusDot'), notice: $('#notice'), reloadButton: $('#reloadButton'),
  backButton: $('#backButton'), forwardButton: $('#forwardButton'), openTabButton: $('#openTabButton'),
  newFolderButton: $('#newFolderButton'), toast: $('#toast'), targetSelect: $('#targetSelect'),
  targetWrap: $('#targetWrap')
};

let current = null;
let swReady = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const store = db.createObjectStore(FILE_STORE, { keyPath: 'key' });
        store.createIndex('session', 'session', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'session' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearDatabase() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([FILE_STORE, META_STORE], 'readwrite');
    tx.objectStore(FILE_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function normalizePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function stripTopFolder(entries) {
  const normalized = entries.map((item) => ({ ...item, path: normalizePath(item.path) })).filter((item) => item.path);
  if (!normalized.length) return { entries: normalized, top: '' };

  const firstParts = normalized.map((item) => item.path.split('/')[0]);
  const sameTop = firstParts.every((part) => part === firstParts[0]) && normalized.every((item) => item.path.includes('/'));
  if (!sameTop) return { entries: normalized, top: '' };

  const top = firstParts[0];
  return {
    top,
    entries: normalized.map((item) => ({ ...item, path: item.path.slice(top.length + 1) })).filter((item) => item.path)
  };
}

function pathRoot(indexPath) {
  return indexPath.slice(0, -'index.html'.length);
}

function rootLabel(root) {
  return root || '/';
}

function rootKind(root) {
  const clean = root.replace(/\/$/, '').toLowerCase();
  if (!clean) return 'root';
  const known = [
    ['.output/public', 'output'], ['storybook-static', 'build'], ['dist', 'build'], ['build', 'build'],
    ['out', 'build'], ['public', 'public'], ['site', 'public'], ['www', 'public'], ['docs', 'docs']
  ];
  for (const [suffix, kind] of known) {
    if (clean === suffix || clean.endsWith(`/${suffix}`)) return kind;
  }
  return 'other';
}

function rootBaseScore(root) {
  const clean = root.replace(/\/$/, '').toLowerCase();
  if (!clean) return 80;
  const scores = [
    ['.output/public', 300], ['storybook-static', 275], ['dist', 300], ['build', 285],
    ['out', 275], ['public', 155], ['site', 165], ['www', 165], ['docs', 125]
  ];
  for (const [suffix, score] of scores) {
    if (clean === suffix || clean.endsWith(`/${suffix}`)) return score;
  }
  return 90 - Math.min(35, clean.split('/').length * 5);
}

function resolveReferencePath(value, root, indexPath) {
  const cleanValue = value.split('#')[0].split('?')[0].trim();
  if (!cleanValue || cleanValue.startsWith('#') || cleanValue.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(cleanValue)) return null;

  if (cleanValue.startsWith('/')) return `${root}${cleanValue.slice(1)}`;
  const indexDir = indexPath.includes('/') ? indexPath.slice(0, indexPath.lastIndexOf('/') + 1) : '';
  const parts = `${indexDir}${cleanValue}`.split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop(); else normalized.push(part);
  }
  return normalized.join('/');
}

function collectHTMLReferences(html) {
  const refs = [];
  const attrPattern = /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) refs.push(match[1]);
  return refs;
}

async function analyzeCandidate(indexEntry, allEntries, pathSet) {
  const indexPath = indexEntry.path;
  const root = pathRoot(indexPath);
  const html = await indexEntry.file.text();
  const filesInRoot = allEntries.filter((item) => item.path.startsWith(root));
  const relativeFiles = filesInRoot.map((item) => item.path.slice(root.length));
  let score = rootBaseScore(root);
  const reasons = [];

  const sourceSignals = [
    { re: /(?:src|href)=["']\/?src\//i, points: -260, label: 'riferisce file sorgente /src/' },
    { re: /<script[^>]+src=["'][^"']+\.(?:tsx?|jsx)(?:[?#"'])/i, points: -360, label: 'carica TypeScript/JSX non compilato' },
    { re: /\/@vite\/client|@react-refresh/i, points: -360, label: 'entrypoint di sviluppo Vite' },
    { re: /<!--\s*(?:app-html|head-outlet)\s*-->/i, points: -170, label: 'template di prerender non compilato' }
  ];
  for (const signal of sourceSignals) {
    if (signal.re.test(html)) {
      score += signal.points;
      reasons.push(signal.label);
    }
  }

  const hasJS = relativeFiles.some((path) => /\.(?:m?js|cjs)$/i.test(path));
  const hasCSS = relativeFiles.some((path) => /\.css$/i.test(path));
  if (hasJS) score += 25;
  if (hasCSS) score += 20;

  if (/(?:assets|static)\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)/i.test(html)) {
    score += 75;
    reasons.push('asset compilati versionati');
  }

  if (/<body[\s\S]*?>[\s\S]{1500,}<\/body>/i.test(html)) {
    score += 35;
    reasons.push('HTML già prerenderizzato');
  }

  const refs = collectHTMLReferences(html).slice(0, 80);
  let resolved = 0;
  let missingAssets = 0;
  for (const ref of refs) {
    const fullPath = resolveReferencePath(ref, root, indexPath);
    if (!fullPath) continue;
    const looksLikeAsset = /\.(?:css|m?js|cjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|avif|mp4|webm|wasm)(?:$|[?#])/i.test(ref);
    if (!looksLikeAsset) continue;
    if (pathSet.has(fullPath)) resolved += 1;
    else missingAssets += 1;
  }
  score += Math.min(70, resolved * 7);
  score -= Math.min(90, missingAssets * 12);
  if (resolved) reasons.push(`${resolved} asset locali risolti`);
  if (missingAssets) reasons.push(`${missingAssets} asset locali mancanti`);

  const sourceFileCount = relativeFiles.filter((path) => /\.(?:tsx?|jsx|vue|svelte)$/i.test(path)).length;
  if (root === '' && sourceFileCount > 0 && !hasJS) {
    score -= 90;
    reasons.push('root prevalentemente sorgente');
  }

  if (rootKind(root) === 'build') reasons.push('directory di build riconosciuta');

  return {
    root,
    entry: 'index.html',
    indexPath,
    score,
    kind: rootKind(root),
    fileCount: filesInRoot.length,
    reasons,
    sourceLike: score < 0 || sourceSignals.some((signal) => signal.re.test(html))
  };
}

async function analyzeProject(entries) {
  const stripped = stripTopFolder(entries);
  const normalizedEntries = stripped.entries.filter((item) => !/(^|\/)(?:node_modules|\.git)(?:\/|$)/i.test(item.path));
  const pathSet = new Set(normalizedEntries.map((item) => item.path));
  const indexEntries = normalizedEntries.filter((item) => /(^|\/)index\.html$/i.test(item.path));

  if (!indexEntries.length) {
    throw new Error('Non trovo nessun index.html. Se il progetto richiede una build, eseguila prima e includi la cartella di output (dist, build, out…).');
  }

  const candidates = await Promise.all(indexEntries.map((entry) => analyzeCandidate(entry, normalizedEntries, pathSet)));
  candidates.sort((a, b) => b.score - a.score || a.root.split('/').length - b.root.split('/').length || a.root.localeCompare(b.root));

  return { normalizedEntries, strippedTop: stripped.top, candidates, selected: candidates[0] };
}

async function storeProject(fileEntries, projectName) {
  const analysis = await analyzeProject(fileEntries);
  const mount = analysis.selected;
  const session = crypto.randomUUID();
  const db = await openDB();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([FILE_STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    for (const item of analysis.normalizedEntries) {
      if (item.path.endsWith('/')) continue;
      store.put({
        key: `${session}:${item.path}`,
        session,
        path: item.path,
        blob: item.file,
        type: item.file.type || ''
      });
    }

    tx.objectStore(META_STORE).put({
      session,
      projectName,
      entry: mount.entry,
      mountRoot: mount.root,
      fileCount: analysis.normalizedEntries.length,
      mountedFileCount: mount.fileCount,
      candidates: analysis.candidates,
      importedAt: Date.now()
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();

  return {
    session,
    projectName,
    entry: mount.entry,
    mountRoot: mount.root,
    fileCount: analysis.normalizedEntries.length,
    mountedFileCount: mount.fileCount,
    candidates: analysis.candidates,
    selected: mount
  };
}

async function setMountRoot(candidate) {
  if (!current || !candidate) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const request = store.get(current.session);
    request.onsuccess = () => {
      const meta = request.result;
      if (!meta) return reject(new Error('Sessione di preview non trovata.'));
      meta.mountRoot = candidate.root;
      meta.entry = candidate.entry;
      meta.mountedFileCount = candidate.fileCount;
      store.put(meta);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();

  current.mountRoot = candidate.root;
  current.entry = candidate.entry;
  current.mountedFileCount = candidate.fileCount;
  current.selected = candidate;
  updateProjectUI();
  els.previewFrame.src = virtualURL('/');
  els.addressBar.value = '/';
}

function virtualBase(project = current) {
  const appBase = new URL('./', location.href).pathname;
  return `${appBase}${VIRTUAL_SEGMENT}/${project.session}/`;
}

function virtualURL(path = '', project = current) {
  const raw = String(path || '/');
  const [pathAndQuery, hash = ''] = raw.split('#', 2);
  const qIndex = pathAndQuery.indexOf('?');
  const pathname = (qIndex >= 0 ? pathAndQuery.slice(0, qIndex) : pathAndQuery).replace(/^\/+/, '');
  const search = qIndex >= 0 ? pathAndQuery.slice(qIndex) : '';
  const url = new URL(`${virtualBase(project)}${pathname}`, location.origin);
  url.search = search;
  url.hash = hash ? `#${hash}` : '';
  return url.href;
}

function previewPathFromURL(url) {
  if (!current) return '/';
  try {
    const u = new URL(url, location.href);
    const base = virtualBase();
    if (!u.pathname.startsWith(base)) return u.href;
    const p = decodeURIComponent(u.pathname.slice(base.length));
    return `/${p}${u.search}${u.hash}`;
  } catch { return '/'; }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3600);
}

function showNotice(message = '') {
  els.notice.textContent = message;
  els.notice.hidden = !message;
}

function candidateLabel(candidate, index) {
  const where = rootLabel(candidate.root);
  const tag = index === 0 ? ' · consigliato' : candidate.sourceLike ? ' · sorgente' : '';
  return `${where}${tag}`;
}

function updateProjectUI() {
  if (!current) return;
  els.projectName.textContent = current.projectName;
  els.projectMeta.textContent = `${current.mountedFileCount} file serviti · root ${rootLabel(current.mountRoot)}`;

  if (current.candidates.length > 1) {
    els.targetWrap.hidden = false;
    els.targetSelect.innerHTML = '';
    current.candidates.forEach((candidate, index) => {
      const option = document.createElement('option');
      option.value = candidate.root;
      option.textContent = candidateLabel(candidate, index);
      option.selected = candidate.root === current.mountRoot;
      els.targetSelect.append(option);
    });
  } else {
    els.targetWrap.hidden = true;
  }

  const selectedIndex = current.candidates.findIndex((candidate) => candidate.root === current.mountRoot);
  const selected = current.candidates[selectedIndex] || current.selected;
  if (current.mountRoot) {
    const why = selected?.reasons?.slice(0, 2).join(' · ');
    showNotice(`Target rilevato: ${rootLabel(current.mountRoot)}${why ? ` — ${why}` : ''}`);
  } else if (selected?.sourceLike) {
    showNotice('L’index in root sembra un entrypoint sorgente. Se esiste una build, selezionala dal menu Target.');
  } else {
    showNotice('');
  }
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Questo browser non supporta Service Worker, necessari per la preview.');
  if (!window.isSecureContext) throw new Error('La preview richiede HTTPS oppure localhost. GitHub Pages è compatibile.');
  if (!swReady) {
    swReady = (async () => {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      await registration.update().catch(() => {});
      return navigator.serviceWorker.ready;
    })();
  }
  return swReady;
}

async function loadProject(entries, projectName) {
  if (!entries.length) return;
  els.statusDot.classList.remove('ready');
  showToast('Analisi struttura e build…');
  await ensureServiceWorker();
  await clearDatabase();
  current = await storeProject(entries, projectName || 'Progetto locale');

  els.emptyState.hidden = true;
  els.workspace.hidden = false;
  els.statusDot.classList.add('ready');
  updateProjectUI();

  els.previewFrame.src = virtualURL('/');
  els.addressBar.value = '/';
}

function entriesFromInput(fileList) {
  const files = [...fileList];
  const projectName = files[0]?.webkitRelativePath?.split('/')[0] || 'Progetto locale';
  return {
    projectName,
    entries: files.map((file) => ({ file, path: file.webkitRelativePath || file.name }))
  };
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function walkEntry(entry, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: `${prefix}${entry.name}` }];
  }
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(entry.createReader());
    const chunks = await Promise.all(children.map((child) => walkEntry(child, `${prefix}${entry.name}/`)));
    return chunks.flat();
  }
  return [];
}

async function entriesFromDrop(dataTransfer) {
  const items = [...dataTransfer.items].filter((item) => item.kind === 'file');
  const roots = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (roots.length) {
    const chunks = await Promise.all(roots.map((entry) => walkEntry(entry)));
    return { projectName: roots.length === 1 ? roots[0].name : 'Progetto locale', entries: chunks.flat() };
  }
  const files = [...dataTransfer.files];
  return { projectName: 'Progetto locale', entries: files.map((file) => ({ file, path: file.name })) };
}

function navigateAddress() {
  if (!current) return;
  const raw = els.addressBar.value.trim();
  if (/^https?:\/\//i.test(raw)) {
    window.open(raw, '_blank', 'noopener,noreferrer');
    return;
  }
  els.previewFrame.src = virtualURL(raw || '/');
}

els.pickFolder.addEventListener('click', (event) => { event.stopPropagation(); els.folderInput.click(); });
els.newFolderButton.addEventListener('click', () => els.folderInput.click());
els.dropZone.addEventListener('click', (event) => { if (!event.target.closest('button')) els.folderInput.click(); });
els.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.folderInput.click();
  }
});
els.folderInput.addEventListener('change', async () => {
  try {
    const { entries, projectName } = entriesFromInput(els.folderInput.files);
    await loadProject(entries, projectName);
  } catch (error) {
    showToast(error.message || String(error));
  } finally {
    els.folderInput.value = '';
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('is-dragging');
  });
}
els.dropZone.addEventListener('drop', async (event) => {
  try {
    const { entries, projectName } = await entriesFromDrop(event.dataTransfer);
    await loadProject(entries, projectName);
  } catch (error) {
    showToast(error.message || String(error));
  }
});

els.targetSelect.addEventListener('change', async () => {
  try {
    const candidate = current?.candidates.find((item) => item.root === els.targetSelect.value);
    await setMountRoot(candidate);
  } catch (error) {
    showToast(error.message || String(error));
  }
});

els.reloadButton.addEventListener('click', () => {
  try { els.previewFrame.contentWindow.location.reload(); }
  catch { els.previewFrame.src = els.previewFrame.src; }
});
els.backButton.addEventListener('click', () => { try { els.previewFrame.contentWindow.history.back(); } catch {} });
els.forwardButton.addEventListener('click', () => { try { els.previewFrame.contentWindow.history.forward(); } catch {} });
els.openTabButton.addEventListener('click', () => { if (els.previewFrame.src) window.open(els.previewFrame.src, '_blank', 'noopener'); });
els.addressBar.addEventListener('keydown', (event) => { if (event.key === 'Enter') navigateAddress(); });
els.previewFrame.addEventListener('load', () => {
  try { els.addressBar.value = previewPathFromURL(els.previewFrame.contentWindow.location.href); }
  catch { els.addressBar.value = previewPathFromURL(els.previewFrame.src); }
});

ensureServiceWorker().catch((error) => showToast(error.message));
