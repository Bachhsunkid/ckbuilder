import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // a dummy key: unit tests never touch the chain, and dotenv does not override it with the real one
    env: { PRIVATE_KEY: `0x${'11'.repeat(32)}` },
  },
});
