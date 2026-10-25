import { defineConfig } from 'vitest/config';

// Live tests against the cluster: one file at a time (they share the login rate limit and user B).
export default defineConfig({
  test: { include: ['*.test.mjs'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, sequence: { concurrent: false } },
});
