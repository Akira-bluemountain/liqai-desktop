/**
 * Vitest configuration for the LiqAI desktop app.
 *
 * Scope: unit / white-box tests of lib modules that do not require a
 * running Tauri webview, RPC, or bundler. Browser-dependent code (React
 * hooks, wagmi, Next.js) is explicitly kept out of the test target for
 * now — those will live in a separate config with @vitejs/plugin-react
 * and jsdom once we need them.
 *
 * Security-critical files tested here:
 *   - src/lib/sessionKeyPolicy.ts  (the Q1 remediation surface)
 *
 * The hoisted vitest@2.1.9 binary at the workspace root is used.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/**/*.{test,spec}.ts', 'src/lib/**/__tests__/**/*.{test,spec}.ts'],
    // Security tests live close to the code they protect. Keep them
    // short-running so `npm run test` stays a no-excuse pre-commit check.
    testTimeout: 10_000,
  },
});
