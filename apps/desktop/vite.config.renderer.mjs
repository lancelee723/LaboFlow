// Renderer-only dev server (companion to the direct-bundle Electron launch
// used for automated acceptance). Mirrors the renderer section of
// electron.vite.config.ts so plugin dev/HMR behaves the same.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: ".",
  server: { port: 5173, strictPort: true },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src"),
      "@pi-desktop/i18n": resolve(__dirname, "../../packages/i18n/src/index.ts"),
    },
  },
});
