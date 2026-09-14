# Site Folder Preview

Static web app pensata per GitHub Pages che permette di selezionare una cartella locale e visualizzare il sito contenuto al suo interno senza caricare i file su un server.

## Supporto

- progetti statici con `index.html` alla root;
- cartelle pubblicabili rilevate automaticamente: `public/`, `dist/`, `build/`, `out/`, `docs/`, `site/`, `www/`;
- HTML multipagina, CSS, JavaScript, immagini, font e altri asset;
- link root-relative (`/assets/...`) riscritti nel filesystem virtuale;
- fallback SPA verso `index.html` per route senza file fisico;
- drag & drop cartella nei browser Chromium e selezione tramite `webkitdirectory`.

## Limiti intenzionali

Questa applicazione **non esegue npm, Vite, Next.js, Astro o altri tool di build nel browser**. Se un progetto contiene solo sorgenti che richiedono compilazione, va caricata la directory di output (`dist/`, `build/`, ecc.) oppure la cartella principale deve già contenerla.

API o backend remoti non vengono emulati: continueranno a dipendere dai rispettivi server e dalle loro policy CORS.

## Deploy su GitHub Pages

Pubblica questi file nella root del repository e abilita **Settings → Pages → Deploy from a branch** (branch `main`, cartella `/root`). Il Service Worker richiede HTTPS, fornito automaticamente da GitHub Pages.

`.nojekyll` è incluso per evitare elaborazioni Jekyll non necessarie.
