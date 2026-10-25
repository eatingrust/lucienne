import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist', manifest: true, rollupOptions: { input: {
    companion: fileURLToPath(new URL('index.html', import.meta.url)),
    spacetime: fileURLToPath(new URL('spacetime.html', import.meta.url)),
    fixture: fileURLToPath(new URL('fixture.html', import.meta.url)),
  } } },
});
