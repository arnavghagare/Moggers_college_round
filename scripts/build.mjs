// Builds the extension into dist/.
//
// Two Vite builds are needed because the pieces load differently:
//   1. Extension pages and the service worker are ES modules and may share chunks.
//   2. The content script must be one self-contained classic script.
import react from '@vitejs/plugin-react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch') ? {} : null;
const dev = watch !== null;

const shared = {
  root,
  configFile: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

const pages = build({
  ...shared,
  plugins: [react()],
  base: './',
  publicDir: join(root, 'public'),
  build: {
    outDir: join(root, 'dist'),
    // In watch mode the two builds rebuild independently, so neither may wipe the other's output.
    emptyOutDir: !dev,
    target: 'chrome116',
    sourcemap: dev,
    minify: !dev,
    modulePreload: false,
    chunkSizeWarningLimit: 1200,
    watch,
    rollupOptions: {
      input: {
        dashboard: join(root, 'dashboard.html'),
        popup: join(root, 'popup.html'),
        newtab: join(root, 'newtab.html'),
        offscreen: join(root, 'offscreen.html'),
        'service-worker': join(root, 'src/background/service-worker.ts'),
      },
      output: {
        // The service worker must sit at the extension root with a fixed name.
        entryFileNames: (chunk) => (chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

const first = await pages;
if (dev && first && typeof first.on === 'function') {
  // Let the first watch build finish before the content script build starts writing.
  await new Promise((resolve) => {
    first.on('event', (event) => {
      if (event.code === 'END' || event.code === 'ERROR') resolve();
    });
  });
}

await build({
  ...shared,
  publicDir: false,
  build: {
    outDir: join(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    watch,
    lib: {
      entry: join(root, 'src/content/content.ts'),
      formats: ['iife'],
      name: 'HandsfreeContent',
      fileName: () => 'content.js',
    },
  },
});

if (!dev) console.log('\nBuilt dist/ - load it in chrome://extensions with "Load unpacked".');
