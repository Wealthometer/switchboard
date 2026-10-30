import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const api = process.env.API_URL ?? "http://localhost:4000"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/health": api,
      "/socket.io": { target: api, ws: true },
    },
  },
})
