import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  // dev convenience: proxy API to the local server
  server: { proxy: { '/api': { target: process.env.LABOFLOW_API ?? 'http://127.0.0.1:3000', rewrite: (p) => p.slice(4) } } },
});
