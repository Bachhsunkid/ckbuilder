import type { FiberWasmFactory } from '@fiber-pay/sdk/browser';

// SDK 0.3.1 still emits an obsolete Testnet CKB Auth cell dependency.
// Match config/testnet/config.yml from the official Fiber v0.10.1 release.
const obsoleteAuthTx =
  '0x5a5288769cecde6451cb5d301416c297a6da43dc3ac2f3253542b4082478b19b';
const testnetAuthTx =
  '0x12c569a258dd9c5bd99f632bb8314b1263b90921ba31496467580d6b79dd14a7';

export async function createTestnetFiberFactory(): Promise<FiberWasmFactory> {
  const { Fiber } = await import('@nervosnetwork/fiber-js');

  return () => {
    const fiber = new Fiber();
    return {
      start: (config, ...args) => {
        const currentConfig = /chain:\s*testnet\b/.test(config)
          ? config.replaceAll(obsoleteAuthTx, testnetAuthTx)
          : config;
        return fiber.start(currentConfig, ...args);
      },
      stop: () => fiber.stop(),
      invokeCommand: (name, args) => fiber.invokeCommand(name, args),
    };
  };
}
