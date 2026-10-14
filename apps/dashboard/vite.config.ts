import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev -w apps/dashboard` proxies /api and /mcp to the gateway on k3d. The gateway refuses
// mutating requests from a foreign Origin (AUTH-03), so the proxy presents the gateway's own origin.
const gateway = process.env.GATEWAY_ORIGIN ?? 'http://app.127.0.0.1.nip.io';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, assetsInlineLimit: 0 }, // no data: URIs, so the CSP needs no exceptions
  server: {
    proxy: {
      '/api': { target: gateway, changeOrigin: true, headers: { origin: gateway } },
    },
  },
});
