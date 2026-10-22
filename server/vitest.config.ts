import { defineConfig } from "vitest/config";

// setupFiles: a scratch CAIRN_HOME per test file, so a spawned guard's
// refusal row never lands in the real ~/.cairn (#358).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup-cairn-home.ts"] },
});
