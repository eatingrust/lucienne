import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '../../../contracts/bridge.js';
import { App } from './app.js';
import './style.css';
declare global { interface Window { lucienne?: DesktopBridge } }
createRoot(document.getElementById('root')!).render(<App bridge={window.lucienne} />);
