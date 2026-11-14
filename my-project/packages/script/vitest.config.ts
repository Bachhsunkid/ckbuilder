import { defineConfig } from 'vitest/config';

// ckb-testtool drives ckb-debugger through stdin; parallel workers can deadlock (see week-05 README).
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 60_000 },
});
