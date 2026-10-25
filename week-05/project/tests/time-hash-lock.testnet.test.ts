import { ccc, hexFrom, hashCkb, hashTypeToBytes, numLeToBytes, WitnessArgs } from '@ckb-ccc/core';
import scripts from '../deployment/scripts.json';
import systemScripts from '../deployment/system-scripts.json';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

// Spends real testnet CKB. Run with: RUN_TESTNET=1 npx jest tests/time-hash-lock.testnet --maxWorkers=1
const run = process.env.RUN_TESTNET ? describe : describe.skip;

const ABSOLUTE_TIMESTAMP_FLAG = 0x4000000000000000n;
const PASSPHRASE = hexFrom(new TextEncoder().encode('open sesame'));
const LOCKED = ccc.fixedPointFrom('200'); // 200 CKB per cell, the lock args alone need 116 CKB
const FEE = 10_000n; // shannons, far above the 1000 shannons/KB minimum fee rate

run('time-hash-lock on testnet', () => {
  const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev' });
  const signer = new ccc.SignerCkbPrivateKey(client, process.env.PRIVATE_KEY!);

  const jsVm = systemScripts.testnet['ckb_js_vm'];
  const contract = scripts.testnet['time-hash-lock.bc'];
  const cellDeps = [...jsVm.script.cellDeps.map((c) => c.cellDep), ...contract.cellDeps.map((c) => c.cellDep)];

  const now = BigInt(Math.floor(Date.now() / 1000));
  const openSince = ABSOLUTE_TIMESTAMP_FLAG | (now - 3600n); // already reached
  const futureSince = ABSOLUTE_TIMESTAMP_FLAG | (now + 1800n); // 30 minutes from now

  const lockWith = (minSince: bigint) => ({
    codeHash: jsVm.script.codeHash,
    hashType: jsVm.script.hashType,
    args: hexFrom(
      '0x0000' +
        contract.codeHash.slice(2) +
        hexFrom(hashTypeToBytes(contract.hashType)).slice(2) +
        hashCkb(PASSPHRASE).slice(2) +
        hexFrom(numLeToBytes(minSince, 8)).slice(2),
    ),
  });

  let lockTxHash: string;

  // Builds a tx that spends output `index` of the lock tx back to the signer, with the given since and witness.
  const unlockTx = async (index: number, since: bigint, passphrase?: string) => {
    const receiver = (await signer.getRecommendedAddressObj()).script;
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: { txHash: lockTxHash, index }, since }],
      outputs: [{ lock: receiver, capacity: LOCKED - FEE }],
      outputsData: ['0x'],
      cellDeps,
      witnesses: [passphrase ? hexFrom(WitnessArgs.from({ lock: passphrase }).toBytes()) : '0x'],
    });
    return tx;
  };

  const rejection = async (tx: ccc.Transaction) => {
    try {
      await client.sendTransaction(tx);
    } catch (e) {
      return String(e);
    }
    throw new Error('expected the node to reject the transaction');
  };

  test('lock two cells: one already unlockable, one for 30 minutes from now', async () => {
    const tx = ccc.Transaction.from({
      outputs: [
        { lock: lockWith(openSince), capacity: LOCKED },
        { lock: lockWith(futureSince), capacity: LOCKED },
      ],
      outputsData: ['0x', '0x'],
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, 1000);
    lockTxHash = await signer.sendTransaction(tx);
    console.log(`LOCK tx: ${lockTxHash}  (cell 0 unlock-at ${openSince & 0xffffffffffffffn}, cell 1 unlock-at ${futureSince & 0xffffffffffffffn})`);
    await client.waitTransaction(lockTxHash, 0, 120_000);
  }, 180_000);

  test('wrong passphrase is rejected by the script (error 3)', async () => {
    const msg = await rejection(await unlockTx(0, openSince, hexFrom(new TextEncoder().encode('open sesame!'))));
    console.log(`WRONG PASSPHRASE -> ${msg}`);
    expect(msg).toMatch(/error code 3|code 3|-3/i);
  }, 60_000);

  test('since below the minimum is rejected by the script (error 4)', async () => {
    const msg = await rejection(await unlockTx(0, ABSOLUTE_TIMESTAMP_FLAG | 1n, PASSPHRASE));
    console.log(`SINCE TOO LOW -> ${msg}`);
    expect(msg).toMatch(/error code 4|code 4/i);
  }, 60_000);

  test('right passphrase but the chain has not reached since yet is rejected by the node (immature)', async () => {
    const msg = await rejection(await unlockTx(1, futureSince, PASSPHRASE));
    console.log(`TOO EARLY -> ${msg}`);
    expect(msg).toMatch(/immature|since/i);
  }, 60_000);

  test('right passphrase and a reached since unlocks the cell', async () => {
    const tx = await unlockTx(0, openSince, PASSPHRASE);
    const txHash = await client.sendTransaction(tx);
    console.log(`UNLOCK tx: ${txHash}`);
    await client.waitTransaction(txHash, 0, 120_000);
  }, 180_000);
});
