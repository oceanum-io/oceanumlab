import { defineConfig } from 'vitest/config';

/**
 * This package keeps the vitest suite it was written with, rather than being rewritten for
 * oceanumlab's jest. The sign-in code and these tests move together, so converting them in the
 * same change that moved them would leave both unverified — and the package is still kept in
 * step with oceanum-notebook, which runs them under vitest too.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
});
