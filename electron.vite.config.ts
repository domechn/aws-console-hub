import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Production-only CSP: in dev the React plugin injects an inline refresh
 * preamble that `script-src 'self'` would block.
 */
const CSP =
  // connect-src: the renderer never talks to the network itself; LLM and AWS calls run in the main process.
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"

export default defineConfig({
  // pi is ESM-only (no `require` export condition), so the CJS main bundle must inline it rather than require() it.
  main: {
    build: {
      // typebox (card schema, shared with pi) is ESM-only too.
      externalizeDeps: { exclude: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', 'typebox', 'quickjs-emscripten-core', '@jitl/quickjs-singlefile-cjs-release-sync'] },
      // The AI tools load each @aws-sdk/client-* on first use; keep that a lazy require() of the CJS build
      // instead of a native import() going through Node's ESM loader.
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), sandbox: resolve('src/main/ai/sandbox.ts'), 'sandbox.worker': resolve('src/main/ai/sandbox.worker.ts') },
        output: { dynamicImportInCjs: false }
      }
    }
  },
  // Second entries: the toast overlay view (main/toast.ts) with its own minimal preload.
  preload: {
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), toast: resolve('src/preload/toast.ts') } } }
  },
  renderer: {
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), toast: resolve('src/renderer/toast.html') } }
    },
    plugins: [
      react(),
      {
        name: 'csp',
        apply: 'build',
        transformIndexHtml: () => [
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }
        ]
      }
    ]
  }
})
