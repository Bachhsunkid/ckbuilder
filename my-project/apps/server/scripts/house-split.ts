// Splits the operator balance into N plain cells so N bets can open in the same block (SPEC 7.2 shards).
// Usage: npx tsx scripts/house-split.ts <count> <ckbEach>
import { ccc } from '@ckb-ccc/core';
import { config } from '../src/config';

const count = Number(process.argv[2] ?? 8);
const each = ccc.fixedPointFrom(process.argv[3] ?? '3000');

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
const signer = new ccc.SignerCkbPrivateKey(client, config.privateKey);
const lock = (await signer.getRecommendedAddressObj()).script;
const tx = ccc.Transaction.from({
  outputs: Array.from({ length: count }, () => ({ lock, capacity: each })),
  outputsData: Array.from({ length: count }, () => '0x'),
});
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer, 1000);
const hash = await signer.sendTransaction(tx);
console.log('split tx', hash);
await client.waitTransaction(hash, 1, 300_000);
console.log('committed; balance', ccc.fixedPointToString(await signer.getBalance()), 'CKB');
process.exit(0);
