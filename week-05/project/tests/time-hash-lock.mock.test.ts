import { hexFrom, Transaction, WitnessArgs, hashTypeToBytes, hashCkb, numLeToBytes } from '@ckb-ccc/core';
import { readFileSync } from 'fs';
import { Resource, Verifier, DEFAULT_SCRIPT_CKB_JS_VM } from 'ckb-testtool';

// error codes returned by contracts/time-hash-lock/src/index.ts
const ERR_ARGS = 1;
const ERR_WITNESS = 2;
const ERR_PASSPHRASE = 3;
const ERR_SINCE = 4;
const ERR_SINCE_METRIC = 5;

const PASSPHRASE = hexFrom(new TextEncoder().encode('open sesame'));
const ABSOLUTE_TIMESTAMP_FLAG = 0x4000000000000000n;
const UNLOCK_AT = ABSOLUTE_TIMESTAMP_FLAG | 1_800_000_000n; // metric: seconds since epoch

// Builds a tx that spends one cell locked by time-hash-lock and recreates it.
function buildTx(name: string, opts: { witnessLock?: string; since?: bigint; shortTail?: boolean }) {
  const resource = Resource.default();
  const tx = Transaction.default();

  const jsVm = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
  const contract = resource.deployCell(hexFrom(readFileSync(process.env.CONTRACT ?? 'dist/time-hash-lock.bc')), tx, false);

  const tail = opts.shortTail
    ? '00'.repeat(33)
    : hashCkb(PASSPHRASE).slice(2) + hexFrom(numLeToBytes(UNLOCK_AT, 8)).slice(2);
  jsVm.args = hexFrom(
    '0x0000' + contract.codeHash.slice(2) + hexFrom(hashTypeToBytes(contract.hashType)).slice(2) + tail,
  );
  const lock = jsVm;

  const inputCell = resource.mockCell(lock);
  const input = Resource.createCellInput(inputCell);
  if (opts.since !== undefined) input.since = opts.since;
  tx.inputs.push(input);
  tx.outputs.push(Resource.createCellOutput(lock));
  tx.outputsData.push(hexFrom('0x'));
  if (opts.witnessLock !== undefined) {
    tx.witnesses.push(hexFrom(WitnessArgs.from({ lock: opts.witnessLock }).toBytes()));
  }
  const verifier = Verifier.from(resource, tx);
  // DUMP_DIR=txs npm run test:only  writes each tx as JSON that ckb-debugger can replay
  if (process.env.DUMP_DIR) verifier.dump(`${process.env.DUMP_DIR}/${name}.json`);
  return verifier;
}

describe('time-hash-lock contract', () => {
  test('unlocks with the right passphrase and a since past the minimum', async () => {
    const verifier = buildTx('unlock-ok', { witnessLock: PASSPHRASE, since: UNLOCK_AT + 1n });
    const cycles = await verifier.verifySuccess(true);
    console.log(`cycles: ${cycles}`);
  });

  test('fails with the wrong passphrase', async () => {
    const verifier = buildTx('wrong-passphrase', {
      witnessLock: hexFrom(new TextEncoder().encode('open sesame!')),
      since: UNLOCK_AT,
    });
    await verifier.verifyFailure(ERR_PASSPHRASE, true);
  });

  test('fails when the input since is below the minimum', async () => {
    const verifier = buildTx('since-too-low', { witnessLock: PASSPHRASE, since: UNLOCK_AT - 1n });
    await verifier.verifyFailure(ERR_SINCE, true);
  });

  test('fails when the input has no since at all (0 is the block-number metric)', async () => {
    const verifier = buildTx('no-since', { witnessLock: PASSPHRASE });
    await verifier.verifyFailure(ERR_SINCE_METRIC, true);
  });

  test('fails when since uses a different metric (block number instead of timestamp)', async () => {
    const verifier = buildTx('wrong-metric', { witnessLock: PASSPHRASE, since: 2_000_000_000n });
    await verifier.verifyFailure(ERR_SINCE_METRIC, true);
  });

  test('fails when there is no witness', async () => {
    const verifier = buildTx('no-witness', { since: UNLOCK_AT });
    await verifier.verifyFailure(ERR_WITNESS, true);
  });

  test('fails when the args have the wrong length', async () => {
    const verifier = buildTx('bad-args', { witnessLock: PASSPHRASE, since: UNLOCK_AT, shortTail: true });
    await verifier.verifyFailure(ERR_ARGS, true);
  });
});
