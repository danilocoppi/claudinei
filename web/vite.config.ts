/// <reference types="vitest/config" />
import { defineConfig, createLogger } from 'vite'
import react from '@vitejs/plugin-react'

// Logger customizado que engole o "ws proxy socket error" (EPIPE/ECONNRESET)
// do proxy de WebSocket em dev. Esse erro é benigno: ocorre quando o navegador
// recarrega ou o backend reinicia e o socket já fechou — não afeta o app.
const logger = createLogger()
const originalError = logger.error
logger.error = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('ws proxy socket error')) return
  originalError(msg, options)
}

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: {
    port: 9100,
    strictPort: true,
    // Objeto, não string: na forma de string o Vite liga `changeOrigin` e
    // reescreve o Host para 127.0.0.1:9105. O servidor só aceita escrita em /api
    // e WebSocket da MESMA origem (Origin igual ao Host), então o Host do
    // navegador (localhost:9100) precisa chegar intacto.
    proxy: {
      '/api': { target: 'http://127.0.0.1:9105' },
      '/ws': { target: 'ws://127.0.0.1:9105', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
})
