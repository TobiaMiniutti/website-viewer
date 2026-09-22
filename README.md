# Site Preview v3.0

Viewer statico pensato per `viewer.miniutti.it`. Permette di aprire e controllare siti statici direttamente nel browser, senza inviare i file a un backend.

## Modalità di apertura

- **Cartella progetto** — analizza tutti gli `index.html`, distingue gli entrypoint sorgente dalle build e preferisce automaticamente output come `dist/`, `build/`, `out/`, `.output/public/` e `storybook-static/`.
- **File HTML singolo** — apre rapidamente un documento `.html`/`.htm`. Gli asset locali esterni al file non sono disponibili: per quelli usa la cartella progetto.
- **HTML incollato** — accetta sia il solo contenuto del `<body>` sia un documento HTML completo. CSS e JavaScript possono essere aggiunti separatamente.

## Viewer

- navigazione avanti/indietro e reload;
- barra percorso virtuale;
- cambio manuale del target quando esistono più build plausibili;
- preset di viewport Fit, Desktop (1440 px), Tablet (768 px) e Mobile (390 px);
- apertura della preview in una nuova scheda;
- SPA fallback e route statiche (`/privacy/` → `privacy/index.html`);
- riscrittura di URL root-relative, `fetch`, XHR, history API e asset verso il filesystem virtuale.

## Privacy e sicurezza

I file importati vengono conservati localmente in IndexedDB e serviti alla preview da un Service Worker. Non è previsto alcun upload verso un backend.

Il JavaScript contenuto nei progetti e nel codice incollato viene eseguito nel browser: aprire solo contenuti di cui ci si fida.

## Deploy GitHub Pages

Pubblicare nella root del repository:

- `index.html`
- `app.js`
- `sw.js`
- `styles.css`
- `.nojekyll`
- `CNAME`

`CNAME` contiene `viewer.miniutti.it`. Il dominio deve essere configurato lato DNS/GitHub Pages separatamente.

HTTPS è necessario perché la preview usa Service Worker; GitHub Pages è compatibile.

## Limiti

È un viewer, non un runtime Node o un backend. Non esegue `npm install`, Vite dev server, SSR Node, PHP, database o API locali. Se un progetto richiede una build, la cartella di output deve essere già presente.
