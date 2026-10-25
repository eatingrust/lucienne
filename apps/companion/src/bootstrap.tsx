import { mountCompanion } from './index.js';
import type { CompanionPorts, PrivateStorage } from './controller.js';
declare global { interface Window { lucienneCompanionPorts?: CompanionPorts } }
// Configuration is injected by an owner-controlled entrypoint. Never parse tokens from URLs.
const storage: PrivateStorage = {
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
};
const app = mountCompanion(document.getElementById('root')!, window.lucienneCompanionPorts, { storage });
window.addEventListener('pagehide', () => app.dispose(), { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
