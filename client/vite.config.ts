import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const clientDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientDir,
  resolve: {
    alias: {
      "@tesroid/shared": path.resolve(clientDir, "../shared/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
  },
});
