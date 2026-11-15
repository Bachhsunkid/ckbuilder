import * as bindings from '@ckb-js-std/bindings';
import { HighLevel, hashCkb } from '@ckb-js-std/core';
import * as P from '@ckb-mines/protocol';
import * as PS from '@ckb-mines/protocol/session';

// Mines session lock (ADR 0001). Guards one session cell: a two-party state
// channel between a player and the operator. All rules live in
// PS.checkSession; this file only reads the transaction for it.

const VM_LOADER_ARGS = 35;

const H: P.Hash = (d) => new Uint8Array(hashCkb(d.slice().buffer));

/** blake160 of the compressed public key that signed `msg`, via the VM's native secp256k1. */
const keyHashOf: PS.KeyHashOf = (sig, msg) => {
  if (sig.length !== PS.SIG_LEN || sig[64] > 3 || msg.length !== 32) return null;
  try {
    const raw = bindings.secp256k1.recover(sig.slice(0, 64).buffer, sig[64], msg.slice().buffer);
    const pub = new Uint8Array(bindings.secp256k1.serializePubkey(raw, true));
    return H(pub).slice(0, 20);
  } catch (e) {
    return null;
  }
};

function all<T>(load: (i: number, s: bindings.SourceType) => T, source: bindings.SourceType): T[] {
  const out: T[] = [];
  for (const v of new HighLevel.QueryIter(load, source)) out.push(v);
  return out;
}

function main(): number {
  const lockArgs = new Uint8Array(HighLevel.loadScript().args);
  const args = PS.decodeSessionArgs(lockArgs.slice(VM_LOADER_ARGS));
  if (args === null) return P.ERR_ARGS;

  const groupInputs = all(HighLevel.loadCellCapacity, bindings.SOURCE_GROUP_INPUT).length;
  if (groupInputs !== 1) return P.ERR_GROUP;

  let witness: ArrayBuffer | undefined;
  try {
    witness = HighLevel.loadWitnessArgs(0, bindings.SOURCE_GROUP_INPUT).lock;
  } catch (e) {
    return P.ERR_WITNESS;
  }
  if (witness === undefined) return P.ERR_WITNESS;

  const self = new Uint8Array(HighLevel.loadScriptHash());
  const outLocks = all(HighLevel.loadCellLockHash, bindings.SOURCE_OUTPUT).map((h) => new Uint8Array(h));
  const outCaps = all(HighLevel.loadCellCapacity, bindings.SOURCE_OUTPUT);
  const inLocks = all(HighLevel.loadCellLockHash, bindings.SOURCE_INPUT).map((h) => new Uint8Array(h));
  const inCaps = all(HighLevel.loadCellCapacity, bindings.SOURCE_INPUT);

  const sessionOutputs: PS.SessionOutput[] = [];
  for (let i = 0; i < outLocks.length; i++) {
    if (!P.bytesEqual(outLocks[i], self)) continue;
    sessionOutputs.push({
      capacity: outCaps[i],
      data: new Uint8Array(HighLevel.loadCellData(i, bindings.SOURCE_OUTPUT)),
      hasType: HighLevel.loadCellTypeHash(i, bindings.SOURCE_OUTPUT) !== null,
    });
  }

  const flowTo = (lock: Uint8Array): bigint => {
    let flow = 0n;
    for (let i = 0; i < outLocks.length; i++) if (P.bytesEqual(outLocks[i], lock)) flow += outCaps[i];
    for (let i = 0; i < inLocks.length; i++) if (P.bytesEqual(inLocks[i], lock)) flow -= inCaps[i];
    return flow;
  };

  return PS.checkSession(
    {
      lockArgs,
      args,
      groupInputs,
      inputCapacity: HighLevel.loadCellCapacity(0, bindings.SOURCE_GROUP_INPUT),
      inputData: new Uint8Array(HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT)),
      since: HighLevel.loadInputSince(0, bindings.SOURCE_GROUP_INPUT),
      witness: new Uint8Array(witness),
      sessionOutputs,
      flowTo,
    },
    H,
    keyHashOf,
  );
}

bindings.exit(main());
