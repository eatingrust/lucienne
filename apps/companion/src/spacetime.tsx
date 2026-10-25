import { createSpacetimeCompanion } from '@lucienne/session/spacetime-companion';
import { mountCompanion } from './index.js';
import type { PrivateStorage } from './controller.js';

/** session service's selected transport; one SDK identity is shared by its pair/read ports. */
export function mountSpacetimeCompanion(element: HTMLElement, options: { uri: string; databaseName: string; storage: PrivateStorage }) {
  const prefix = `lucienne.companion.${options.uri}/${options.databaseName}.`;
  const storage: PrivateStorage = {
    getItem: key => options.storage.getItem(prefix + key),
    setItem: (key, value) => options.storage.setItem(prefix + key, value),
    removeItem: key => options.storage.removeItem(prefix + key),
  };
  let cleanup = () => {}, disposed = false;
  const start = () => {
    let transport: ReturnType<typeof createSpacetimeCompanion>;
    try {
      transport = createSpacetimeCompanion({ uri: options.uri, databaseName: options.databaseName,
        authToken: storage.getItem('transport-identity') ?? undefined,
        onToken: token => storage.setItem('transport-identity', token),
      });
    } catch { showSetupError(); return; }
    const app = mountCompanion(element, transport, { storage, clearPairing: clearSavedConnection,
      pairingTarget: { uri: options.uri, databaseName: options.databaseName } });
    cleanup = () => { app.dispose(); transport.close(); };
  };
  const showSetupError = () => {
    // Do not leak provider errors or stored identity into rendered output.
    const section = document.createElement('main');
    const heading = document.createElement('h1'); heading.textContent = 'Connection setup needs attention';
    const message = document.createElement('p'); message.textContent = 'Private session storage or the saved connection is unavailable. Clear the saved connection to retry.';
    const button = document.createElement('button'); button.textContent = 'Clear saved connection'; button.onclick = clearSavedConnection;
    section.append(heading, message, button); element.replaceChildren(section);
    cleanup = () => { button.onclick = null; element.replaceChildren(); };
  };
  const clearSavedConnection = () => {
    if (disposed) return;
    cleanup();
    try {
      storage.removeItem('transport-identity');
      storage.removeItem('lucienne.companion.reader.v1');
    } catch { showSetupError(); return; }
    start();
  };
  start();
  return { dispose() { if (disposed) return; disposed = true; cleanup(); } };
}
