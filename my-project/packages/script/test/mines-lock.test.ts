import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { ccc, hexFrom, hashTypeToBytes, Script, Transaction, WitnessArgs } from '@ckb-ccc/core';
import { Resource, Verifier, DEFAULT_SCRIPT_CKB_JS_VM, DEFAULT_SCRIPT_ALWAYS_SUCCESS } from 'ckb-testtool';
import * as P from '@ckb-mines/protocol';

const H: P.Hash = (d) => new Uint8Array(ccc.bytesFrom(ccc.hashCkb(d)));
const seed = (n: number) => H(Uint8Array.of(n & 0xff, n >> 8));
const CKB = P.SHANNONS_PER_CKB;
const D_EXIT = 900n;
const D_FORFEIT = 86_400n;
const relative = (seconds: bigint) => P.SINCE_RELATIVE_TIMESTAMP | seconds;
const BYTECODE = process.env.CONTRACT ?? 'dist/mines-lock.bc';

interface Game {
  S: Uint8Array;
  C: Uint8Array;
  picks: Uint8Array[];
  layout: P.Layout;
  args: P.BetArgs;
  safeTiles: number[];
  mineTiles: number[];
}

function makeGame(m: number, n: number, stakeCkb = 20n): Game {
  const S = seed(1000 + n);
  const C = seed(2000 + n);
  const picks = Array.from({ length: 9 }, (_, t) => seed(3000 + 10 * n + t));
  const layout = P.buildLayout(S, m, H);
  const pi = P.tileMap(C, H);
  return {
    S,
    C,
    picks,
    layout,
    args: {
      playerLockHash: new Uint8Array(32),
      houseLockHash: new Uint8Array(32),
      R: layout.root,
      C,
      Q: P.pickRoot(picks, H),
      m,
      stake: stakeCkb * CKB,
      dExit: D_EXIT,
      dForfeit: D_FORFEIT,
    },
    safeTiles: [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 0),
    mineTiles: [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 1),
  };
}

interface Spend {
  witness?: P.Witness | Uint8Array | null;
  since?: bigint;
  player?: boolean;
  house?: boolean;
  /** capacity of the output locked by the house, in shannons */
  houseOut?: bigint;
  /** a second bet cell in the same group */
  twoBets?: boolean;
  rawArgs?: Uint8Array;
}

function spend(g: Game, s: Spend) {
  const resource = Resource.default();
  const tx = Transaction.default();
  const jsVm = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
  const contract = resource.deployCell(hexFrom(readFileSync(BYTECODE)), tx, false);
  const always = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
  const playerLock = Script.from({ codeHash: always.codeHash, hashType: always.hashType, args: '0x01' });
  const houseLock = Script.from({ codeHash: always.codeHash, hashType: always.hashType, args: '0x02' });
  const args = { ...g.args, playerLockHash: ccc.bytesFrom(playerLock.hash()), houseLockHash: ccc.bytesFrom(houseLock.hash()) };
  const encoded = s.rawArgs ?? P.encodeArgs({ ...args, playerLockHash: new Uint8Array(args.playerLockHash), houseLockHash: new Uint8Array(args.houseLockHash) });
  const betLock = Script.from({
    codeHash: jsVm.codeHash,
    hashType: jsVm.hashType,
    args: hexFrom('0x0000' + contract.codeHash.slice(2) + hexFrom(hashTypeToBytes(contract.hashType)).slice(2) + P.toHex(encoded).slice(2)),
  });
  const capacity = P.betCapacity(g.args.stake, g.args.m);

  const betInput = Resource.createCellInput(resource.mockCell(betLock, undefined, '0x', capacity));
  if (s.since !== undefined) betInput.since = s.since;
  tx.inputs.push(betInput);
  const w = s.witness === undefined ? null : s.witness;
  tx.witnesses.push(
    w === null ? '0x' : hexFrom(WitnessArgs.from({ lock: hexFrom(w instanceof Uint8Array ? w : P.encodeWitness(w)) }).toBytes()),
  );
  if (s.twoBets) {
    tx.inputs.push(Resource.createCellInput(resource.mockCell(betLock, undefined, '0x', capacity)));
    tx.witnesses.push('0x');
  }
  if (s.player ?? true) {
    tx.inputs.push(Resource.createCellInput(resource.mockCell(playerLock, undefined, '0x', 100n * CKB)));
    tx.witnesses.push('0x');
  }
  if (s.house ?? true) {
    tx.inputs.push(Resource.createCellInput(resource.mockCell(houseLock, undefined, '0x', 3000n * CKB)));
    tx.witnesses.push('0x');
  }
  if (s.houseOut !== undefined) {
    tx.outputs.push(Resource.createCellOutput(houseLock, undefined, s.houseOut));
    tx.outputsData.push('0x');
  }
  tx.outputs.push(Resource.createCellOutput(playerLock, undefined, 100n * CKB));
  tx.outputsData.push('0x');
  return Verifier.from(resource, tx);
}

const lossWitness = (g: Game, t: number): P.Witness => ({ path: 'B', S: g.S, t, p: g.picks[t], pickProof: P.pickProof(g.picks, t, H) });
const receiptsFor = (g: Game, tiles: number[]) => tiles.map((t) => P.makeReceipt(g.layout, g.C, t, H)!);
const cycles: Record<string, number> = {};

describe('path A: cooperative', () => {
  const g = makeGame(2, 1);
  test('passes with a player input and a house input', async () => {
    cycles['A'] = await spend(g, { witness: { path: 'A' } }).verifySuccess();
  });
  test('fails without the player input', async () => {
    await spend(g, { witness: { path: 'A' }, player: false }).verifyFailure(P.ERR_NO_PLAYER_INPUT);
  });
  test('fails without the house input', async () => {
    await spend(g, { witness: { path: 'A' }, house: false }).verifyFailure(P.ERR_NO_HOUSE_INPUT);
  });
});

describe('path B: operator proves a loss', () => {
  for (const m of [2, 3, 4]) {
    test(`m=${m}: passes when the picked tile is a mine`, async () => {
      const g = makeGame(m, 10 + m);
      cycles[`B m=${m}`] = await spend(g, { witness: lossWitness(g, g.mineTiles[0]), player: false }).verifySuccess();
    });
  }
  const g = makeGame(3, 20);
  test('fails on a safe tile', async () => {
    await spend(g, { witness: lossWitness(g, g.safeTiles[0]), player: false }).verifyFailure(P.ERR_NOT_A_MINE);
  });
  test('fails with another seed (rigged layout)', async () => {
    const w = { ...(lossWitness(g, g.mineTiles[0]) as Extract<P.Witness, { path: 'B' }>), S: seed(7) };
    await spend(g, { witness: w, player: false }).verifyFailure(P.ERR_LAYOUT_ROOT);
  });
  test('fails on a tile the player never committed to (wrong pick secret)', async () => {
    const w = { ...(lossWitness(g, g.mineTiles[0]) as Extract<P.Witness, { path: 'B' }>), p: seed(8) };
    await spend(g, { witness: w, player: false }).verifyFailure(P.ERR_PICK_PROOF);
  });
  test('fails without the house input', async () => {
    await spend(g, { witness: lossWitness(g, g.mineTiles[0]), house: false }).verifyFailure(P.ERR_NO_HOUSE_INPUT);
  });
});

describe('path C: player exits alone', () => {
  for (const m of [2, 3, 4]) {
    test(`m=${m}: passes with every safe tile and the house paid its share`, async () => {
      const g = makeGame(m, 30 + m);
      const k = 9 - m;
      const due = P.houseShareOnExit(P.betCapacity(g.args.stake, m), g.args.stake, k, m);
      cycles[`C m=${m} k=${k}`] = await spend(g, {
        witness: { path: 'C', receipts: receiptsFor(g, g.safeTiles) },
        since: relative(D_EXIT),
        house: false,
        houseOut: due > 0n ? due : undefined,
      }).verifySuccess();
    });
  }
  const g = makeGame(2, 40, 50n);
  const capacity = P.betCapacity(g.args.stake, 2);
  const two = receiptsFor(g, g.safeTiles.slice(0, 2));
  const due2 = capacity - P.payout(g.args.stake, 2, 2).payout;
  test('k = 0 refunds the stake, house gets the collateral', async () => {
    await spend(g, { witness: { path: 'C', receipts: [] }, since: relative(D_EXIT), house: false, houseOut: capacity - g.args.stake }).verifySuccess();
  });
  test('fails when the house gets one shannon less than its share', async () => {
    await spend(g, { witness: { path: 'C', receipts: two }, since: relative(D_EXIT), house: false, houseOut: due2 - 1n }).verifyFailure(
      P.ERR_HOUSE_UNDERPAID,
    );
  });
  test('fails before D_exit', async () => {
    await spend(g, { witness: { path: 'C', receipts: two }, since: relative(D_EXIT - 1n), house: false, houseOut: due2 }).verifyFailure(P.ERR_SINCE);
  });
  test('fails with an absolute since', async () => {
    await spend(g, { witness: { path: 'C', receipts: two }, since: 0x4000000000000000n | 2_000_000_000n, house: false, houseOut: due2 }).verifyFailure(
      P.ERR_SINCE,
    );
  });
  test('fails with a duplicate receipt', async () => {
    await spend(g, { witness: { path: 'C', receipts: [two[0], two[0]] }, since: relative(D_EXIT), house: false, houseOut: due2 }).verifyFailure(
      P.ERR_RECEIPT,
    );
  });
  test('fails with a forged receipt', async () => {
    await spend(g, { witness: { path: 'C', receipts: [{ ...two[0], salt: seed(9) }] }, since: relative(D_EXIT), house: false, houseOut: due2 }).verifyFailure(
      P.ERR_RECEIPT,
    );
  });
  test('fails with a receipt moved to a mine tile', async () => {
    await spend(g, { witness: { path: 'C', receipts: [{ ...two[0], t: g.mineTiles[0] }] }, since: relative(D_EXIT), house: false, houseOut: due2 }).verifyFailure(
      P.ERR_RECEIPT,
    );
  });
  test('fails without the player input', async () => {
    await spend(g, { witness: { path: 'C', receipts: two }, since: relative(D_EXIT), player: false, houseOut: due2 }).verifyFailure(
      P.ERR_NO_PLAYER_INPUT,
    );
  });
  test('dust rule: a house share below 61 CKB is forgiven', async () => {
    const small = makeGame(2, 41, 10n);
    expect(P.houseShareOnExit(P.betCapacity(small.args.stake, 2), small.args.stake, 7, 2)).toBe(0n);
    await spend(small, { witness: { path: 'C', receipts: receiptsFor(small, small.safeTiles) }, since: relative(D_EXIT), house: false }).verifySuccess();
  });
});

describe('path D: house reclaims an abandoned bet', () => {
  const g = makeGame(4, 50);
  test('passes after D_forfeit', async () => {
    cycles['D'] = await spend(g, { witness: { path: 'D' }, since: relative(D_FORFEIT), player: false }).verifySuccess();
  });
  test('fails before D_forfeit', async () => {
    await spend(g, { witness: { path: 'D' }, since: relative(D_EXIT), player: false }).verifyFailure(P.ERR_SINCE);
  });
  test('fails without the house input', async () => {
    await spend(g, { witness: { path: 'D' }, since: relative(D_FORFEIT), house: false }).verifyFailure(P.ERR_NO_HOUSE_INPUT);
  });
});

describe('malformed spends', () => {
  const g = makeGame(2, 60);
  test('two bet cells in one transaction', async () => {
    await spend(g, { witness: { path: 'A' }, twoBets: true }).verifyFailure(P.ERR_GROUP);
  });
  test('no witness', async () => {
    await spend(g, { witness: null }).verifyFailure(P.ERR_WITNESS);
  });
  test('unknown path byte', async () => {
    await spend(g, { witness: Uint8Array.of(7) }).verifyFailure(P.ERR_WITNESS);
  });
  test('mine count outside 2..4', async () => {
    await spend(g, { witness: { path: 'A' }, rawArgs: P.encodeArgs({ ...g.args, m: 5 }) }).verifyFailure(P.ERR_ARGS);
  });
  test('short args', async () => {
    await spend(g, { witness: { path: 'A' }, rawArgs: new Uint8Array(100) }).verifyFailure(P.ERR_ARGS);
  });
});

describe('cycle report', () => {
  test('prints cycles per path', () => {
    console.table(cycles);
    for (const c of Object.values(cycles)) expect(c).toBeLessThan(70_000_000);
  });
});
