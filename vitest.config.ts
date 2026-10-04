import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [],
  test: {
    testTimeout: 15000,
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    clearMocks: true,
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*"],
      exclude: [
        "tests/**",
        "**/*.test.ts",
        "src/dataview.benchmark.ts",
        "src/types.ts",
        "src/index.ts",
      ],
    },
  },
});
