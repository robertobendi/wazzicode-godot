import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// TAURI_DEV_HOST lets `tauri dev` serve to a physical device on the LAN.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Tauri wants a fixed port and its own error surface, not Vite's.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Don't rebuild the frontend when Rust files change.
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
