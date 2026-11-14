import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const packages = ["protocol", "crypto", "config", "storage", "gateway", "executor", "orca_node", "harness"] as const;

export default defineConfig({
  resolve: {
    alias: packages.map((name) => ({
      find: `@orca/${name === "orca_node" ? "orca-node" : name}`,
      replacement: fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
    })),
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
