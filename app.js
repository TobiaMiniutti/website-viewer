const DB_NAME = 'site-folder-preview-v1';
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
  newFolderButton: $('#newFolderButton'), toast: $('#toast')
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
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function stripTopFolder(paths) {
  const normalized = paths.map(normalizePath).filter(Boolean);
  if (!normalized.length) return { paths: normalized, top: '' };
  const firstParts = normalized.map((p) => p.split('/')[0]);
  const sameTop = firstParts.every((p) => p === firstParts[0]) && normalized.some((p) => p.includes('/'));
  if (!sameTop) return { paths: normalized, top: '' };
  const top = firstParts[0];
  return { paths: normalized.map((p) => p.slice(top.length + 1)), top };
}

function chooseMountRoot(paths) {
  const set = new Set(paths);
  if (set.has('index.html')) return { root: '', entry: 'index.html', reason: 'root' };
  const preferred = ['public', 'dist', 'build', 'out', 'docs', 'site', 'www'];
  for (const dir of preferred) {
    if (set.has(`${dir}/index.html`)) return { root: `${dir}/`, entry: 'index.html', reason: dir };
  }
  const candidates = paths.filter((p) => /(^|\/)index\.html$/i.test(p));
  if (candidates.length === 1) {
    const full = candidates[0];
    return { root: full.slice(0, -'index.html'.length), entry: 'index.html', reason: 'auto' };
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
    const full = candidates[0];
    return { root: full.slice(0, -'index.html'.length), entry: 'index.html', reason: 'auto' };
  }
  return null;
}

async function storeProject(fileEntries, projectName) {
  const pathsRaw = fileEntries.map((x) => x.path);
  const stripped = stripTopFolder(pathsRaw);
  const normalizedEntries = fileEntries.map((x, i) => ({ ...x, path: stripped.paths[i] }));
  const mount = chooseMountRoot(normalizedEntries.map((x) => x.path));
  if (!mount) throw new Error('Non trovo un index.html utilizzabile. Se il progetto richiede una build (Vite/React/Next ecc.), carica la cartella di output generata, ad esempio dist/.');

  const session = crypto.randomUUID();
  const mounted = normalizedEntries
    .filter((x) => x.path.startsWith(mount.root) && !x.path.endsWith('/'))
    .map((x) => ({ ...x, virtualPath: x.path.slice(mount.root.length) }))
    .filter((x) => x.virtualPath);

  if (!mounted.some((x) => x.virtualPath === mount.entry)) throw new Error('La directory rilevata non contiene index.html.');

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([FILE_STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    for (const item of mounted) {
      store.put({
        key: `${session}:${item.virtualPath}`,
        session,
        path: item.virtualPath,
        blob: item.file,
        type: item.file.type || ''
      });
    }
    tx.objectStore(META_STORE).put({
      session,
      projectName,
      entry: mount.entry,
      mountRoot: mount.root,
      fileCount: mounted.length,
      importedAt: Date.now()
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return { session, projectName, entry: mount.entry, mountRoot: mount.root, fileCount: mounted.length, reason: mount.reason };
}

function virtualBase(project = current) {
  const appBase = new URL('./', location.href).pathname;
  return `${appBase}${VIRTUAL_SEGMENT}/${project.session}/`;
}

function virtualURL(path = '', project = current) {
  const clean = String(path || '').replace(/^\/+/, '');
  return new URL(`${virtualBase(project)}${clean}`, location.origin).href;
}

function previewPathFromURL(url) {
  if (!current) return '/';
  try {
    const u = new URL(url, location.href);
    const base = virtualBase();
    if (!u.pathname.startsWith(base)) return u.href;
    const p = u.pathname.slice(base.length);
    return `/${decodeURIComponent(p)}${u.search}${u.hash}`;
  } catch { return '/'; }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

function showNotice(message = '') {
  els.notice.textContent = message;
  els.notice.hidden = !message;
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Questo browser non supporta Service Worker, necessari per la preview.');
  if (!window.isSecureContext) throw new Error('La preview richiede HTTPS oppure localhost. GitHub Pages è compatibile.');
  if (!swReady) {
    swReady = (async () => {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
      return navigator.serviceWorker.ready;
    })();
  }
  return swReady;
}

async function loadProject(entries, projectName) {
  if (!entries.length) return;
  els.statusDot.classList.remove('ready');
  showToast('Indicizzazione della cartella…');
  await ensureServiceWorker();
  await clearDatabase();
  current = await storeProject(entries, projectName || 'Progetto locale');

  els.projectName.textContent = current.projectName;
  const rootLabel = current.mountRoot || '/';
  els.projectMeta.textContent = `${current.fileCount} file · root ${rootLabel}`;
  els.emptyState.hidden = true;
  els.workspace.hidden = false;
  els.statusDot.classList.add('ready');

  if (current.mountRoot) {
    showNotice(`Directory pubblica rilevata automaticamente: ${current.mountRoot}`);
  } else {
    showNotice('');
  }

  els.previewFrame.src = virtualURL(current.entry);
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
      all.push(...batch); next();
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
  const items = [...dataTransfer.items].filter((i) => i.kind === 'file');
  const roots = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
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

els.pickFolder.addEventListener('click', (e) => { e.stopPropagation(); els.folderInput.click(); });
els.newFolderButton.addEventListener('click', () => els.folderInput.click());
els.dropZone.addEventListener('click', (e) => { if (!e.target.closest('button')) els.folderInput.click(); });
els.dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.folderInput.click(); } });
els.folderInput.addEventListener('change', async () => {
  try {
    const { entries, projectName } = entriesFromInput(els.folderInput.files);
    await loadProject(entries, projectName);
  } catch (error) { showToast(error.message || String(error)); }
  finally { els.folderInput.value = ''; }
});

for (const eventName of ['dragenter', 'dragover']) {
  els.dropZone.addEventListener(eventName, (e) => { e.preventDefault(); els.dropZone.classList.add('is-dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  els.dropZone.addEventListener(eventName, (e) => { e.preventDefault(); els.dropZone.classList.remove('is-dragging'); });
}
els.dropZone.addEventListener('drop', async (e) => {
  try {
    const { entries, projectName } = await entriesFromDrop(e.dataTransfer);
    await loadProject(entries, projectName);
  } catch (error) { showToast(error.message || String(error)); }
});

els.reloadButton.addEventListener('click', () => { try { els.previewFrame.contentWindow.location.reload(); } catch { els.previewFrame.src = els.previewFrame.src; } });
els.backButton.addEventListener('click', () => { try { els.previewFrame.contentWindow.history.back(); } catch {} });
els.forwardButton.addEventListener('click', () => { try { els.previewFrame.contentWindow.history.forward(); } catch {} });
els.openTabButton.addEventListener('click', () => { if (els.previewFrame.src) window.open(els.previewFrame.src, '_blank', 'noopener'); });
els.addressBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateAddress(); });
els.previewFrame.addEventListener('load', () => {
  try { els.addressBar.value = previewPathFromURL(els.previewFrame.contentWindow.location.href); }
  catch { els.addressBar.value = previewPathFromURL(els.previewFrame.src); }
});

ensureServiceWorker().catch((error) => showToast(error.message));
