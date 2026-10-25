import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, RuntimeState } from '../../../contracts/bridge.js';
const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('lucienne:state'),
  command: command => ipcRenderer.invoke('lucienne:command', command),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: RuntimeState) => listener(state);
    ipcRenderer.on('lucienne:state-changed', handler);
    return () => ipcRenderer.removeListener('lucienne:state-changed', handler);
  },
};
contextBridge.exposeInMainWorld('lucienne', bridge);
