import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-page build: overlay.html and settings.html are separate entry points,
// each mapped to a Tauri window (see tauri.conf.json).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Tauri expects a fixed port and no obfuscated asset URLs.
  clearScreen: false,
  resolve: {
    alias: [
      {
        // hangul-romanize@0.1.2 ends its ESM entry with a bare
        // `module.exports = ...`. Vite resolves packages by their `module`
        // field, so that line ships to the webview and throws
        // `ReferenceError: module is not defined` the moment the module is
        // evaluated — killing Korean romaji with a silent catch. Point past the
        // broken barrel at the class module, which is plain ESM.
        //
        // Anchored so the replacement doesn't match itself and recurse. Node
        // resolves the subpath because the package declares no `exports` map.
        //
        // This also makes vitest and the webview load the same file: without it
        // tests resolve the CommonJS `main`, which works in node and hides the
        // breakage.
        find: /^hangul-romanize$/,
        replacement: "hangul-romanize/dist-esm/Romanize.js",
      },
      {
        // kuromoji's dictionary loader calls `path.join` to build dictionary
        // URLs. Vite externalizes Node builtins for the browser, so `path` ends
        // up a stub that throws and kuroshiro never initializes — Japanese
        // romaji and furigana fail silently inside the loader's try/catch.
        // See src/shims/node-path.ts for the (deliberately tiny) surface.
        find: /^path$/,
        replacement: resolve(__dirname, "src/shims/node-path.ts"),
      },
    ],
  },
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
