// Build config for the CS 1.6 Admin runtime frontend bundle (frontend/frontend.mjs).
// Lib mode, everything inlined (React included) — see docs/plugins.md
// "Runtime frontends (frontend.mjs)". Served from /plugins-assets/<name>/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@catalyst/plugin-sdk/frontend',
        replacement: path.resolve(repoRoot, 'sdk-frontend/index.ts'),
      },
    ],
  },
  build: {
    lib: {
      entry: path.resolve(import.meta.dirname, 'frontend/index.ts'),
      formats: ['es'],
      fileName: () => 'frontend.mjs',
    },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
