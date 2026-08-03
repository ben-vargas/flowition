/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// DESIGN §9.1/§9.2/§7.1.4.
//
// `base: './'`         — §9.2, normative, restored in W8b round 1. The earlier deviation
//                        argued that a relative base breaks the §5.8 index fallback for a
//                        path like `/run/x`. It cannot: the product's routes are HASH
//                        routes (§9.1 — "a 60-line hash router"), so §5.8's own words hold
//                        — "deep links are `/` requests anyway" — and the only document
//                        the server ever serves index.html for at a non-root path is a URL
//                        no part of this product produces. Weighed against that, `'./'`
//                        buys the relocatable build the spec asks for: the same dist works
//                        under any mount prefix a future embed picks, and `test/
//                        viewer-http.test.js`'s pipeline assertions (which fetch /app.js
//                        and /app.css from the root mount) are unaffected because a
//                        document at `/` resolves `./app.js` to exactly `/app.js`.
// `modulePreload.polyfill: false`
//                      — Vite 6's default injects an INLINE polyfill <script> into the
//                        built index.html, which `script-src 'self'` blocks (§7.1.4,
//                        critiques B1/Sol-3). Targets are evergreen local browsers.
// stable asset names   — `app.js` / `app.css`, not content hashes. The dist is committed
//                        (§4.6) and served by a local server with `cache-control` under
//                        our own control; stable names keep the committed tree reviewable
//                        as a diff and keep test/viewer-http.test.js's servable-pipeline
//                        assertion (which requests /app.js and /app.css) honest.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4646', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:4646', changeOrigin: false },
    },
    fs: {
      // The shared fold module lives outside viewer/ and is imported by W9 (§9.2).
      allow: ['..'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'app.css' : 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // §11.1: pure logic in node, DOM behaviors via per-file jsdom opt-in
    // (`// @vitest-environment jsdom` at the top of the file).
    restoreMocks: true,
    // Vitest's 5 s default is a budget for a unit test, and this suite is not only unit
    // tests: it mounts real React trees in jsdom, and it now also runs a full end-to-end
    // session against a real viewer server (`features/control/e2e.test.tsx`, §12.1 item 5)
    // in parallel with 59 other files. Under that contention a 3.8 s DOM test and a 5 s
    // ceiling is a coin flip, and a flaky green is worth less than a slow one. A genuinely
    // hung test still fails — later, and for the right reason.
    testTimeout: 20_000,
    server: {
      deps: {
        // The ROOT server modules (`../src/**`) are loaded by NODE, not through Vite's
        // module graph. They are the zero-dependency Node server (§11.1/§16.6): plain ESM
        // that reads its own files relative to `import.meta.url` — §7.3's resume resolves
        // `bin/flowition.js` that way on purpose, so a spawn never depends on
        // `process.cwd()` (src/viewer/control-bridge.js:360). Inlined into Vite's graph
        // that base is a module-graph URL rather than a `file:` one and `fileURLToPath`
        // throws, so the viewer suite's end-to-end test (`features/control/e2e.test.tsx`,
        // which runs a real `startViewer`) saw a 500 from a route that is correct in every
        // environment the product actually runs in. Externalizing is also the more honest
        // arrangement: the server under test should be the server Node runs.
        //
        // The pattern deliberately cannot match `viewer/src/**` — this repo has no
        // `viewer/src/viewer/` — so the SPA's own sources keep their transform.
        external: [/[\\/]src[\\/]viewer[\\/]/, /[\\/]src[\\/][a-z-]+\.js$/],
      },
    },
  },
})
