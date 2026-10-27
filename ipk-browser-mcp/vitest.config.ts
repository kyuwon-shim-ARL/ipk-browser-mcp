import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    // Handler-level tests and the spawned dist server must not reach GitHub (update-check.ts).
    env: { IPK_UPDATE_CHECK: "0" },
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
