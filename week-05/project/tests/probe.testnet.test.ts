import { ccc, hexFrom, WitnessArgs } from '@ckb-ccc/core';
import scripts from '../deployment/scripts.json';
import systemScripts from '../deployment/system-scripts.json';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

// Probe for the Type ID upgrade demo: try to unlock an existing locked cell using a `since`
// with the wrong metric (absolute block number 1, already reached) and print what the node says.
//   LOCK_TX=0x... RUN_TESTNET=1 npx jest tests/probe.testnet --maxWorkers=1
const run = process.env.RUN_TESTNET && process.env.LOCK_TX ? test : test.skip;

run('probe: wrong-metric since on a cell locked before the upgrade', async () => {
  const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev' });
  const signer = new ccc.SignerCkbPrivateKey(client, process.env.PRIVATE_KEY!);
  const jsVm = systemScripts.testnet['ckb_js_vm'];
  const contract = scripts.testnet['time-hash-lock.bc'];
  const receiver = (await signer.getRecommendedAddressObj()).script;
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: { txHash: process.env.LOCK_TX!, index: 1 }, since: 1n }],
    outputs: [{ lock: receiver, capacity: ccc.fixedPointFrom('200') - 10_000n }],
    outputsData: ['0x'],
    cellDeps: [...jsVm.script.cellDeps.map((c) => c.cellDep), ...contract.cellDeps.map((c) => c.cellDep)],
    witnesses: [hexFrom(WitnessArgs.from({ lock: hexFrom(new TextEncoder().encode('open sesame')) }).toBytes())],
  });
  try {
    await client.sendTransaction(tx);
  } catch (e) {
    console.log(`PROBE -> ${String(e)}`);
    return;
  }
  throw new Error('expected rejection');
}, 60_000);
