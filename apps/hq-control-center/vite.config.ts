import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  server: {
    port: 4747,
    host: '0.0.0.0',
    allowedHosts: ['calvins-macbook-pro.tailebc87e.ts.net'],
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      '@repo/vault-client/search': path.resolve(__dirname, 'shims/vault-client/search.ts'),
      '@repo/vault-client': path.resolve(__dirname, 'shims/vault-client/index.ts'),
      '@repo/vault-sync': path.resolve(__dirname, 'shims/vault-sync/index.ts'),
      '@repo/env-loader': path.resolve(__dirname, 'shims/env-loader/index.ts'),
      '@repo/hq-tools': path.resolve(__dirname, 'shims/hq-tools/index.ts'),
      '@repo/relay-adapter-core': path.resolve(__dirname, 'shims/relay-adapter-core/index.ts'),
    },
  },
  ssr: {
    external: ['bun:sqlite', 'bun:ffi'],
  },
  plugins: [
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
})
