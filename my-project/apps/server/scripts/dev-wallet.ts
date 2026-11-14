// Creates a throwaway testnet key for self-testing the web app on localhost and funds it from the operator.
// The key goes to apps/web/.env.local (gitignored) and is only used by `next dev`. Testnet only.
// Run while no bets are in flight: the funding spends operator cells the house also uses.
//   npx tsx scripts/dev-wallet.ts [--fund 400]
import { ccc } from '@ckb-ccc/core';
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';

const i = process.argv.indexOf('--fund');
const FUND = ccc.fixedPointFrom(i >= 0 ? process.argv[i + 1] : '400');
const ENV = path.resolve(import.meta.dirname, '../../web/.env.local');
const NAME = 'NEXT_PUBLIC_DEV_PRIVATE_KEY';

const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);

function loadOrCreateKey(): string {
  const text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const found = text.match(new RegExp(`^${NAME}=(0x[0-9a-f]{64})$`, 'm'));
  if (found) return found[1];
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  const key = ccc.hexFrom(k);
  fs.writeFileSync(ENV, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${NAME}=${key}\n`);
  return key;
}

async function main() {
  const dev = new ccc.SignerCkbPrivateKey(client, loadOrCreateKey());
  const address = await dev.getRecommendedAddress();
  const balance = await dev.getBalance();
  console.log('dev wallet', address, 'balance', ccc.fixedPointToString(balance), 'CKB');
  if (balance >= FUND / 2n) return;
  const operator = new ccc.SignerCkbPrivateKey(client, config.privateKey);
  const tx = ccc.Transaction.from({ outputs: [{ lock: (await dev.getRecommendedAddressObj()).script, capacity: FUND - balance }], outputsData: ['0x'] });
  await tx.completeInputsByCapacity(operator);
  await tx.completeFeeBy(operator, 1000);
  const hash = await operator.sendTransaction(tx);
  console.log('funding', hash);
  await client.waitTransaction(hash, 1, 300_000);
  console.log('funded', ccc.fixedPointToString(await dev.getBalance()), 'CKB');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
