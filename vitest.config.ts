import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    resolve: {
      conditions: ["import", "module", "browser", "default"],
    },
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
