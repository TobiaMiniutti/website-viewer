# Site Folder Preview v2

Viewer statico da pubblicare su GitHub Pages per aprire localmente la cartella principale di un sito e visualizzare la build senza caricare i file su un backend.

## Cosa cambia in v2

- Analizza tutti gli `index.html` invece di scegliere sempre quello più vicino alla root.
- Distingue un entrypoint di sviluppo Vite/React/TypeScript da una build pronta.
- Preferisce automaticamente output come `dist/`, `build/`, `out/`, `.output/public/` e `storybook-static/`.
- Permette di cambiare manualmente il **Target** quando esistono più root plausibili.
- Salva l'intero progetto in IndexedDB, quindi il target può essere cambiato senza selezionare di nuovo la cartella.
- Maschera il prefisso interno della preview nelle build hydrate/SPA che leggono `window.location`.
- Reindirizza link, `history.pushState`, `fetch`, XHR e URL root-relative verso il filesystem virtuale.
- Supporta route statiche come `/privacy/` -> `privacy/index.html`, URL senza estensione e fallback SPA.

## Esempio verificato

Nel progetto `miniutti.it-v6-living-garden` sono presenti sia:

- `/index.html`: template sorgente Vite che carica `/src/entry-client.tsx`;
- `/dist/index.html`: build compilata con JS/CSS bundle e HTML prerenderizzato.

La v1 sceglieva il primo e produceva una pagina bianca. La v2 assegna una forte penalità agli entrypoint sorgente e seleziona `dist/`.

## Deploy su GitHub Pages

Pubblica questi file nella root del repository:

- `index.html`
- `app.js`
- `sw.js`
- `styles.css`
- `.nojekyll`

Funziona sia su dominio Pages root sia su project pages (`username.github.io/repository/`). È richiesto HTTPS o localhost perché usa Service Worker.

## Limiti

È un **viewer**, non un ambiente Node completo. Non esegue `npm install`, Vite dev server, SSR Node, PHP, database o backend. Quando la cartella contiene una build statica già generata, cerca di usarla automaticamente. Le chiamate a vere API/backend possono naturalmente restituire errore in preview.

Caricare solo progetti di cui ci si fida: il JavaScript del progetto viene eseguito nel browser durante l'anteprima.
