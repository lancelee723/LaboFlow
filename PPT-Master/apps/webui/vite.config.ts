import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5990,
    proxy: {
      "/api": {
        target: "http://localhost:5991",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:5991",
        ws: true,
        changeOrigin: true,
      },
      "/share": {
        target: "http://localhost:5991",
        changeOrigin: true,
      },
    },
  },
})
