import { defineConfig } from 'vite';
export default defineConfig({
  root: 'apps/main/renderer', base: './',
  build: { outDir: '../../../dist/renderer', emptyOutDir: true },
  server: { fs: { allow: ['.'] } },
});
