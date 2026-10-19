import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // tsconfig keeps JSX for Next to compile; tests that render a page need it
  // compiled here, with the same automatic runtime Next uses.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": root
    }
  },
  test: {
    environment: "node",
    exclude: ["e2e/**", "node_modules/**", ".next/**"]
  }
});
