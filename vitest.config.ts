import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@partstyle/engine/node": fileURLToPath(
        new URL("./packages/engine/src/node.ts", import.meta.url),
      ),
      "@partstyle/engine": fileURLToPath(
        new URL("./packages/engine/src/index.ts", import.meta.url),
      ),
      "@partstyle/server": fileURLToPath(
        new URL("./packages/server/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Some tests run kicad-cli, ELK layout and an HTTP server for real.
    testTimeout: 30_000,
  },
});
