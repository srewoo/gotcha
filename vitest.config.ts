import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/setup/chrome-mock.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      // UI shells and the MAIN-world bootstrap are exercised by the Playwright
      // e2e harness (test/e2e), not unit tests — excluded from the unit gate.
      exclude: [
        'src/**/*.d.ts',
        'src/injected/main.ts',
        // Intentionally disabled-by-default; ~95 lines of unreachable code after
        // an early return, retained for a future opt-in reimplementation.
        'src/injected/worker-hook.ts',
        // Closed-shadow-DOM in-page widget — internals unreachable from unit
        // tests; its interaction/visual behaviour is covered by the e2e harness.
        'src/content/widget.ts',
        'src/popup/**',
        'src/review/**',
        'src/dashboard/**',
        'src/options/**',
      ],
    },
  },
});
