import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@partstyle/layout-cases": fileURLToPath(
        new URL("./layout/packages/cases/src/index.ts", import.meta.url),
      ),
      "@partstyle/layout": fileURLToPath(
        new URL("./layout/packages/layout/src/index.ts", import.meta.url),
      ),
      "@partstyle/engine/node": fileURLToPath(
        new URL("./packages/engine/src/node.ts", import.meta.url),
      ),
      "@partstyle/engine": fileURLToPath(
        new URL("./packages/engine/src/index.ts", import.meta.url),
      ),
      "@partstyle/server": fileURLToPath(
        new URL("./packages/server/src/index.ts", import.meta.url),
      ),
      "@partstyle/mcp": fileURLToPath(new URL("./packages/mcp/src/serve.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "layout/packages/*/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Some tests run kicad-cli, the layout and an HTTP server for real.
    testTimeout: 30_000,
  },
});
