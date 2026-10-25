import { mountSpacetimeCompanion } from './spacetime.js';
// Supply your own deployment name at build time. No deployment is bundled.
const root = document.getElementById('root')!;
const databaseName = import.meta.env.VITE_SPACETIME_DATABASE;
if (!databaseName) {
  root.textContent = 'Companion connection is not configured. Use fixture.html for a local preview.';
} else {
  const app = mountSpacetimeCompanion(root, {
    uri: 'wss://maincloud.spacetimedb.com', databaseName,
    storage: {
      getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: key => sessionStorage.removeItem(key),
    },
  });
  window.addEventListener('pagehide', () => app.dispose(), { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}
