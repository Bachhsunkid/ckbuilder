import * as bindings from '@ckb-js-std/bindings';
import { HighLevel, hashCkb } from '@ckb-js-std/core';
import * as P from '@ckb-mines/protocol';

// Mines lock (SPEC section 7.3). Guards one bet cell holding the player's stake
// and the house collateral. Four spending paths, chosen by the first byte of
// WitnessArgs.lock of the bet cell input:
//   A  cooperative: an input locked by the player and one locked by the house
//   B  operator wins: house input + evidence that the picked tile is a mine
//   C  player exit: player input + since >= dExit + receipts; house gets the rest
//   D  abandoned: house input + since >= dForfeit
// Signatures are never checked here: requiring an input with a given lock hash
// makes that lock verify its owner's signature over the whole transaction.

const VM_LOADER_ARGS = 35;

const H: P.Hash = (d) => new Uint8Array(hashCkb(d.slice().buffer));

function lockHashes(source: bindings.SourceType): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const h of new HighLevel.QueryIter(HighLevel.loadCellLockHash, source)) out.push(new Uint8Array(h));
  return out;
}

function capacities(source: bindings.SourceType): bigint[] {
  const out: bigint[] = [];
  for (const c of new HighLevel.QueryIter(HighLevel.loadCellCapacity, source)) out.push(c);
  return out;
}

function hasLock(hashes: Uint8Array[], want: Uint8Array): boolean {
  for (const h of hashes) if (P.bytesEqual(h, want)) return true;
  return false;
}

/** Capacity the transaction moves to `lock`: its outputs minus its inputs. */
function netFlow(lock: Uint8Array, inLocks: Uint8Array[]): bigint {
  let flow = 0n;
  const outLocks = lockHashes(bindings.SOURCE_OUTPUT);
  const outCaps = capacities(bindings.SOURCE_OUTPUT);
  for (let i = 0; i < outLocks.length; i++) if (P.bytesEqual(outLocks[i], lock)) flow += outCaps[i];
  const inCaps = capacities(bindings.SOURCE_INPUT);
  for (let i = 0; i < inLocks.length; i++) if (P.bytesEqual(inLocks[i], lock)) flow -= inCaps[i];
  return flow;
}

/** The bet cell input must carry a relative, timestamp-metric since of at least `seconds`. */
function sinceAtLeast(seconds: bigint): boolean {
  const since = HighLevel.loadInputSince(0, bindings.SOURCE_GROUP_INPUT);
  return (since & P.SINCE_FLAGS_MASK) === P.SINCE_RELATIVE_TIMESTAMP && (since & P.SINCE_VALUE_MASK) >= seconds;
}

function main(): number {
  const args = P.decodeArgs(new Uint8Array(HighLevel.loadScript().args).slice(VM_LOADER_ARGS));
  if (args === null || !P.validMines(args.m) || args.stake === 0n) return P.ERR_ARGS;

  const groupCaps = capacities(bindings.SOURCE_GROUP_INPUT);
  if (groupCaps.length !== 1) return P.ERR_GROUP;
  const capacity = groupCaps[0];

  let lock: ArrayBuffer | undefined;
  try {
    lock = HighLevel.loadWitnessArgs(0, bindings.SOURCE_GROUP_INPUT).lock;
  } catch (e) {
    return P.ERR_WITNESS;
  }
  if (lock === undefined) return P.ERR_WITNESS;
  const w = P.decodeWitness(new Uint8Array(lock));
  if (w === null) return P.ERR_WITNESS;

  const inLocks = lockHashes(bindings.SOURCE_INPUT);
  const player = hasLock(inLocks, args.playerLockHash);
  const house = hasLock(inLocks, args.houseLockHash);

  switch (w.path) {
    case 'A':
      if (!player) return P.ERR_NO_PLAYER_INPUT;
      if (!house) return P.ERR_NO_HOUSE_INPUT;
      return P.OK;
    case 'B':
      if (!house) return P.ERR_NO_HOUSE_INPUT;
      return P.checkLoss(args, w, H);
    case 'C': {
      if (!player) return P.ERR_NO_PLAYER_INPUT;
      if (!sinceAtLeast(args.dExit)) return P.ERR_SINCE;
      const k = P.checkReceipts(args, w.receipts, H);
      if (k < 0) return -k;
      const due = P.houseShareOnExit(capacity, args.stake, k, args.m);
      if (due > 0n && netFlow(args.houseLockHash, inLocks) < due) return P.ERR_HOUSE_UNDERPAID;
      return P.OK;
    }
    case 'D':
      if (!house) return P.ERR_NO_HOUSE_INPUT;
      if (!sinceAtLeast(args.dForfeit)) return P.ERR_SINCE;
      return P.OK;
  }
}

bindings.exit(main());
