// Deploys (or upgrades, keeping the Type ID) a contract's JS source on CKB testnet.
// Usage: npx tsx scripts/deploy.ts [--contract mines-session]   (default mines-lock; reads PRIVATE_KEY from my-project/.env)
import { ccc } from '@ckb-ccc/core';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });
const key = process.env.PRIVATE_KEY;
if (!key) throw new Error('PRIVATE_KEY missing in my-project/.env');

// Single source of truth for the deployed code cell, read by the server, the web app and the tests.
const i = process.argv.indexOf('--contract');
const NAME = i >= 0 ? process.argv[i + 1] : 'mines-lock';
if (!['mines-lock', 'mines-session'].includes(NAME)) throw new Error(`unknown contract ${NAME}`);
const OUT = path.resolve(import.meta.dirname, `../../chain/src/${NAME}.testnet.json`);
const BINARY = path.resolve(import.meta.dirname, `../dist/${NAME}.js`);

async function main() {
  const client = new ccc.ClientPublicTestnet();
  const signer = new ccc.SignerCkbPrivateKey(client, key!);
  const lock = (await signer.getRecommendedAddressObj()).script;
  const data = ccc.hexFrom(fs.readFileSync(BINARY));
  const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

  let tx: ccc.Transaction;
  let typeScript: ccc.Script;
  if (previous) {
    // Upgrade: spend the old code cell, recreate it with the same Type ID and new data.
    typeScript = ccc.Script.from(previous.typeScript);
    tx = ccc.Transaction.from({
      inputs: [{ previousOutput: previous.outPoint }],
      outputs: [{ lock, type: typeScript }],
      outputsData: [data],
    });
  } else {
    typeScript = await ccc.Script.fromKnownScript(client, ccc.KnownScript.TypeId, '0x' + '00'.repeat(32));
    tx = ccc.Transaction.from({ outputs: [{ lock, type: typeScript }], outputsData: [data] });
    await tx.completeInputsAtLeastOne(signer);
    typeScript.args = ccc.hashTypeId(tx.inputs[0], 0);
    tx.outputs[0].type = typeScript;
  }
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.TypeId);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  const txHash = await signer.sendTransaction(tx);
  console.log('deploy tx', txHash);
  await client.waitTransaction(txHash, 1, 300_000);

  const record = {
    network: 'testnet',
    txHash,
    outPoint: { txHash, index: 0 },
    typeScript: { codeHash: typeScript.codeHash, hashType: typeScript.hashType, args: typeScript.args },
    // Scripts reference the code by its Type ID hash, so upgrades keep this stable.
    codeHash: typeScript.hash(),
    hashType: 'type',
    dataHash: ccc.hashCkb(data),
    size: (data.length - 2) / 2,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
  console.log(record);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
