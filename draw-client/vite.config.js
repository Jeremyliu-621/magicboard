import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

function httpsConfig() {
  const cert = process.env.MAGICBOARD_TLS_CERT
  const key = process.env.MAGICBOARD_TLS_KEY
  if (!cert || !key) return undefined
  return {
    cert: fs.readFileSync(cert),
    key: fs.readFileSync(key),
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    https: httpsConfig(),
  },
  preview: {
    host: true,
    https: httpsConfig(),
  },
})
