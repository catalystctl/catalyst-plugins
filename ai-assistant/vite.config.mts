// Build config for the AI Assistant runtime frontend bundle (frontend/frontend.mjs).
// Lib mode, everything inlined (React included) — see docs/plugins.md
// "Runtime frontends (frontend.mjs)".
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  plugins: [react()],
  // Browser bundle: never reference Node's `process` (React's dev/prod
  // selector must fold to production at build time).
  define: { 'process.env.NODE_ENV': '"production"' },
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
