import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `pnpm dev` here proxies the API to a viewer server started with `partstyle view --port 7766`.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  // changeOrigin: the server only answers requests addressed to its own host.
  server: { proxy: { "/api": { target: "http://127.0.0.1:7766", changeOrigin: true } } },
});
