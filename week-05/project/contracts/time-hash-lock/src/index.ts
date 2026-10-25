import * as bindings from '@ckb-js-std/bindings';
import { HighLevel, bytesEq, hashCkb, log } from '@ckb-js-std/core';

// Lock script args (after the 35 bytes ckb-js-vm keeps for its loader):
//   [0..32)  ckb-blake2b hash of the secret passphrase
//   [32..40) minimum `since`, little-endian u64, same encoding as CellInput.since
// Unlocking needs: witness.lock == passphrase, and every input of this script group
// to carry a `since` that is at least as far as the minimum, in the same metric.

const VM_LOADER_ARGS = 35;
const HASH_LEN = 32;
const SINCE_LEN = 8;

const ERR_ARGS = 1;
const ERR_WITNESS = 2;
const ERR_PASSPHRASE = 3;
const ERR_SINCE = 4;
const ERR_SINCE_METRIC = 5; // added in v2: tells a wrong metric apart from a too-early since

// top 3 bits: relative flag + metric (block number / epoch / timestamp); low 56 bits: value
const SINCE_FLAGS_MASK = 0xe000000000000000n;
const SINCE_VALUE_MASK = 0x00ffffffffffffffn;

function main(): number {
  log.setLevel(log.LogLevel.Debug);

  const args = HighLevel.loadScript().args.slice(VM_LOADER_ARGS);
  if (args.byteLength !== HASH_LEN + SINCE_LEN) {
    log.debug(`bad args length: ${args.byteLength}`);
    return ERR_ARGS;
  }
  const expectedHash = args.slice(0, HASH_LEN);
  const minSince = new DataView(args).getBigUint64(HASH_LEN, true);

  let passphrase: ArrayBuffer;
  try {
    passphrase = HighLevel.loadWitnessArgs(0, bindings.SOURCE_GROUP_INPUT).lock ?? new ArrayBuffer(0);
  } catch (e) {
    log.debug('no witness for the first input of the group');
    return ERR_WITNESS;
  }
  if (passphrase.byteLength === 0) {
    return ERR_WITNESS;
  }
  if (!bytesEq(hashCkb(passphrase), expectedHash)) {
    log.debug('passphrase hash mismatch');
    return ERR_PASSPHRASE;
  }

  // The chain only lets a tx in once each input's `since` is satisfied, so checking
  // the declared value here is what turns `since` into an enforced timelock.
  for (const since of new HighLevel.QueryIter(HighLevel.loadInputSince, bindings.SOURCE_GROUP_INPUT)) {
    if ((since & SINCE_FLAGS_MASK) !== (minSince & SINCE_FLAGS_MASK)) {
      log.debug(`since ${since} uses another metric than ${minSince}`);
      return ERR_SINCE_METRIC;
    }
    if ((since & SINCE_VALUE_MASK) < (minSince & SINCE_VALUE_MASK)) {
      log.debug(`since ${since} does not reach ${minSince}`);
      return ERR_SINCE;
    }
  }
  return 0;
}

bindings.exit(main());
