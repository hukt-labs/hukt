import { defineConfig } from "vitest/config";

// Local config so vitest resolves against this package and does not climb the
// directory tree to an unrelated ancestor vite config.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
  },
});
