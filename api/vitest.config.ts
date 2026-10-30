import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

// SWC emits decorator metadata, which NestJS dependency injection relies on (esbuild doesn't).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    setupFiles: ["test/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
