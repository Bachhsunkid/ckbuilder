import type { FiberBrowserNode } from '@fiber-pay/sdk/browser';

const channelCapacity = 50_000_000_000n;

export const channelFundingGuidance =
  'Fund this address with more than 500 Testnet CKB. Opening the channel uses 500 CKB plus a separate on-chain transaction fee.';

/** On-chain Testnet CKB (in shannons) held by the node's funding address. */
export async function onChainBalance(node: FiberBrowserNode) {
  const { default_funding_lock_script: script } = await node.nodeInfo();
  const response = await fetch('https://testnet.ckbapp.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'get_cells_capacity',
      params: [{ script, script_type: 'lock' }],
    }),
  });
  const { result } = await response.json();
  if (!response.ok || typeof result?.capacity !== 'string') {
    throw new Error('Could not check the Testnet balance. Try again before opening the channel.');
  }
  return BigInt(result.capacity);
}

export async function requireNewChannelFunding(node: FiberBrowserNode) {
  if (await onChainBalance(node) <= channelCapacity) {
    throw new Error(channelFundingGuidance);
  }
}
