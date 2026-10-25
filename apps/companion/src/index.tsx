import { createRoot } from 'react-dom/client';
import { CompanionApp } from './App.js';
import { createCompanionController } from './controller.js';
import type { CompanionPorts, PrivateStorage } from './controller.js';
import type { PairingFileTarget } from './pairing-file.js';
import './neutral.css';
export type { CompanionPorts, PrivateStorage } from './controller.js';

/** The integration owner supplies the accepted provider ports; no backend is selected here. */
export function mountCompanion(element: HTMLElement, ports?: CompanionPorts, options: { storage?: PrivateStorage; fixture?: boolean; clearPairing?: () => void; pairingTarget?: PairingFileTarget } = {}) {
  const controller = createCompanionController(ports, options.storage);
  const root = createRoot(element);
  root.render(<CompanionApp controller={controller} fixture={options.fixture} clearPairing={options.clearPairing} pairingTarget={options.pairingTarget} />);
  return { controller, dispose() { controller.dispose(); root.unmount(); } };
}
import React from 'react';
