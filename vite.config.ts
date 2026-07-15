import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-page build: overlay.html and settings.html are separate entry points,
// each mapped to a Tauri window (see tauri.conf.json).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Tauri expects a fixed port and no obfuscated asset URLs.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Rust sources are built by cargo, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "overlay.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
