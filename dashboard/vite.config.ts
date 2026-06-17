import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // Built assets are served by the plugin from any route → use relative asset URLs.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  // During `npm run dev`, proxy the data API to the running plugin server.
  server: { proxy: { "/api": "http://localhost:5757" } },
})
