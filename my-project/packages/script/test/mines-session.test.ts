// mines-session lock under ckb-testtool: every mode, every rejection, and a cycle report.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { ccc, hexFrom, hashTypeToBytes, Script, Transaction, WitnessArgs } from '@ckb-ccc/core';
import { Resource, Verifier, DEFAULT_SCRIPT_CKB_JS_VM, DEFAULT_SCRIPT_ALWAYS_SUCCESS } from 'ckb-testtool';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as P from '@ckb-mines/protocol';
import * as PS from '@ckb-mines/protocol/session';

const H: P.Hash = (d) => new Uint8Array(ccc.bytesFrom(ccc.hashCkb(d)));
const seed = (n: number) => H(Uint8Array.of(n & 0xff, n >> 8, 0x5e));
const CKB = P.SHANNONS_PER_CKB;
const D_CHALLENGE = 86_400n;
const BYTECODE = process.env.SESSION_CONTRACT ?? 'dist/mines-session.bc';

const playerKey = seed(1);
const houseKey = seed(2);
const keyHash = (priv: Uint8Array) => H(secp256k1.getPublicKey(priv, true)).slice(0, 20);
/** CKB order: r, s, recovery id (noble's "recovered" puts the id first). */
function sign(priv: Uint8Array, msg: Uint8Array): Uint8Array {
  const s = secp256k1.sign(msg, priv, { prehash: false, format: 'recovered' });
  return P.concat(s.slice(1), s.slice(0, 1));
}

// one round on Easy (7 safe tiles: worst case for receipts) and one on Hard (loss proof)
function round(m: number, n: number, stakeCkb = 20n) {
  const S = seed(100 + n);
  const C = seed(200 + n);
  const picks = Array.from({ length: 9 }, (_, t) => seed(300 + 10 * n + t));
  const layout = P.buildLayout(S, m, H);
  const pi = P.tileMap(C, H);
  const game: PS.SessionGame = { R: layout.root, C, Q: P.pickRoot(picks, H), m, s: stakeCkb * CKB };
  return {
    S,
    C,
    picks,
    layout,
    game,
    safe: [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 0),
    mines: [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 1),
  };
}

interface Env {
  resource: Resource;
  tx: Transaction;
  sessionLock: Script;
  playerLock: Script;
  houseLock: Script;
  typeScript: Script;
  lockArgs: Uint8Array;
}

function env(dChallenge = D_CHALLENGE): Env {
  const resource = Resource.default();
  const tx = Transaction.default();
  const jsVm = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
  const contract = resource.deployCell(hexFrom(readFileSync(BYTECODE)), tx, false);
  const always = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
  const playerLock = Script.from({ codeHash: always.codeHash, hashType: always.hashType, args: '0x01' });
  const houseLock = Script.from({ codeHash: always.codeHash, hashType: always.hashType, args: '0x02' });
  const typeScript = Script.from({ codeHash: always.codeHash, hashType: always.hashType, args: '0x03' });
  const sa = PS.encodeSessionArgs({
    playerLockHash: ccc.bytesFrom(playerLock.hash()),
    houseLockHash: ccc.bytesFrom(houseLock.hash()),
    playerKeyHash: keyHash(playerKey),
    houseKeyHash: keyHash(houseKey),
    dChallenge,
  });
  const args = hexFrom('0x0000' + contract.codeHash.slice(2) + hexFrom(hashTypeToBytes(contract.hashType)).slice(2) + P.toHex(sa).slice(2));
  const sessionLock = Script.from({ codeHash: jsVm.codeHash, hashType: jsVm.hashType, args });
  return { resource, tx, sessionLock, playerLock, houseLock, typeScript, lockArgs: ccc.bytesFrom(args) };
}

const TOTAL = 3000n * CKB;

function signed(e: Env, s: PS.SessionState, keys = { p: playerKey, h: houseKey }) {
  const state = PS.encodeState(s);
  const h = PS.stateHash(e.lockArgs, state, H);
  return { state, h, sigP: sign(keys.p, h), sigH: sign(keys.h, h) };
}

interface Spend {
  data?: Uint8Array;
  capacity?: bigint;
  since?: bigint;
  witness: PS.SessionWitness | Uint8Array;
  /** closing output (data) */
  closing?: { data: Uint8Array; capacity?: bigint; withType?: boolean };
  player?: bigint;
  house?: bigint;
  twoSessions?: boolean;
}

function spend(e: Env, s: Spend) {
  const { resource, tx } = e;
  const capacity = s.capacity ?? TOTAL;
  const input = Resource.createCellInput(resource.mockCell(e.sessionLock, undefined, hexFrom(s.data ?? new Uint8Array()), capacity));
  if (s.since !== undefined) input.since = s.since;
  tx.inputs.push(input);
  const w = s.witness instanceof Uint8Array ? s.witness : PS.encodeSessionWitness(s.witness);
  tx.witnesses.push(hexFrom(WitnessArgs.from({ lock: hexFrom(w) }).toBytes()));
  if (s.twoSessions) {
    tx.inputs.push(Resource.createCellInput(resource.mockCell(e.sessionLock, undefined, '0x', capacity)));
    tx.witnesses.push('0x');
  }
  if (s.closing) {
    tx.outputs.push(Resource.createCellOutput(e.sessionLock, s.closing.withType ? e.typeScript : undefined, s.closing.capacity ?? capacity - 100_000n));
    tx.outputsData.push(hexFrom(s.closing.data));
  }
  if (s.player !== undefined) {
    tx.outputs.push(Resource.createCellOutput(e.playerLock, undefined, s.player));
    tx.outputsData.push('0x');
  }
  if (s.house !== undefined) {
    tx.outputs.push(Resource.createCellOutput(e.houseLock, undefined, s.house));
    tx.outputsData.push('0x');
  }
  return Verifier.from(resource, tx);
}

const closingData = (c: PS.Closing) => PS.encodeClosing(c);
const relative = (seconds: bigint) => P.SINCE_RELATIVE_TIMESTAMP | seconds;
const FEE = 100_000n;
const cycles: Record<string, number> = {};

// balances: player 400, operator 2600 => total 3000 CKB
const idle = (n: bigint, p = 400n * CKB): PS.SessionState => ({ n, p, h: TOTAL - p, final: false, game: null });
function active(n: bigint, r: ReturnType<typeof round>, p = 400n * CKB): PS.SessionState {
  const escrow = PS.sessionEscrow(r.game);
  return { n, p: p - r.game.s, h: TOTAL - p - escrow + r.game.s, final: false, game: r.game };
}

describe('cooperative close', () => {
  test('pays the final balances at once', async () => {
    const e = env();
    const st = signed(e, { ...idle(9n), final: true });
    cycles['coop close'] = await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: TOTAL - 400n * CKB - FEE }).verifySuccess();
  });
  test('rejects a state that is not final', async () => {
    const e = env();
    const st = signed(e, idle(9n));
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: TOTAL - 400n * CKB - FEE }).verifyFailure(PS.ERR_S_STATE);
  });
  test('rejects paying the player less', async () => {
    const e = env();
    const st = signed(e, { ...idle(9n), final: true });
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB - 1n, house: TOTAL - 400n * CKB }).verifyFailure(PS.ERR_S_PAYOUT);
  });
  test('rejects the operator taking more than the fee cap', async () => {
    const e = env();
    const st = signed(e, { ...idle(9n), final: true });
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: TOTAL - 400n * CKB - PS.SESSION_MAX_FEE - 1n }).verifyFailure(PS.ERR_S_PAYOUT);
  });
  test('rejects a wrong player key', async () => {
    const e = env();
    const st = signed(e, { ...idle(9n), final: true }, { p: seed(66), h: houseKey });
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: TOTAL - 400n * CKB - FEE }).verifyFailure(PS.ERR_S_SIG);
  });
  test('rejects a signature over another state', async () => {
    const e = env();
    const st = signed(e, { ...idle(9n), final: true });
    const other = signed(e, { ...idle(9n, 500n * CKB), final: true });
    await spend(e, { witness: { mode: 'coop', state: other.state, sigP: st.sigP, sigH: other.sigH }, player: 500n * CKB, house: TOTAL - 500n * CKB - FEE }).verifyFailure(
      PS.ERR_S_SIG,
    );
  });
});

describe('unilateral close and updates', () => {
  const r = round(4, 1);
  test('close posts a fully signed state with an active round', async () => {
    const e = env();
    const st = signed(e, active(5n, r));
    cycles['close (2 sigs)'] = await spend(e, {
      witness: { mode: 'close', ...st },
      closing: { data: closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false }) },
    }).verifySuccess();
  });
  test('close rejects a closing record that does not match', async () => {
    const e = env();
    const st = signed(e, active(5n, r));
    await spend(e, { witness: { mode: 'close', ...st }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 3, lossProven: false }) } }).verifyFailure(PS.ERR_S_OUTPUT);
  });
  test('close rejects a type script on the closing cell', async () => {
    const e = env();
    const st = signed(e, active(5n, r));
    await spend(e, { witness: { mode: 'close', ...st }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false }), withType: true } }).verifyFailure(
      PS.ERR_S_OUTPUT,
    );
  });
  test('close rejects draining capacity beyond the fee cap', async () => {
    const e = env();
    const st = signed(e, active(5n, r));
    await spend(e, {
      witness: { mode: 'close', ...st },
      closing: { data: closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false }), capacity: TOTAL - PS.SESSION_MAX_FEE - 1n },
    }).verifyFailure(PS.ERR_S_OUTPUT);
  });
  test('close is not allowed on a cell that is already closing', async () => {
    const e = env();
    const st = signed(e, active(5n, r));
    const data = closingData({ n: 4n, stateHash: new Uint8Array(32), k: 0, lossProven: false });
    await spend(e, { data, witness: { mode: 'close', ...st }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false }) } }).verifyFailure(PS.ERR_S_MODE);
  });
  test('update replaces the posted state with a later one', async () => {
    const e = env();
    const later = signed(e, idle(8n, 900n * CKB));
    const data = closingData({ n: 5n, stateHash: new Uint8Array(32), k: 2, lossProven: false });
    cycles['update'] = await spend(e, { data, witness: { mode: 'update', ...later }, closing: { data: closingData({ n: 8n, stateHash: later.h, k: 0, lossProven: false }) } }).verifySuccess();
  });
  test('update rejects an older or equal state', async () => {
    const e = env();
    const older = signed(e, idle(5n));
    const data = closingData({ n: 5n, stateHash: new Uint8Array(32), k: 0, lossProven: false });
    await spend(e, { data, witness: { mode: 'update', ...older }, closing: { data: closingData({ n: 5n, stateHash: older.h, k: 0, lossProven: false }) } }).verifyFailure(PS.ERR_S_NONCE);
  });
});

describe('evidence for the active round', () => {
  const easy = round(2, 2);
  const hard = round(4, 3);
  test('receipts: all 7 safe tiles on Easy (worst case)', async () => {
    const e = env();
    const st = signed(e, active(5n, easy));
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    const receipts = easy.safe.map((t) => P.makeReceipt(easy.layout, easy.C, t, H)!);
    cycles['receipts (7)'] = await spend(e, { data, witness: { mode: 'receipts', state: st.state, receipts }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 7, lossProven: false }) } }).verifySuccess();
  });
  test('receipts cannot be posted twice for the same state', async () => {
    const e = env();
    const st = signed(e, active(5n, easy));
    const data = closingData({ n: 5n, stateHash: st.h, k: 1, lossProven: false });
    const receipts = easy.safe.slice(0, 2).map((t) => P.makeReceipt(easy.layout, easy.C, t, H)!);
    await spend(e, { data, witness: { mode: 'receipts', state: st.state, receipts }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 2, lossProven: false }) } }).verifyFailure(PS.ERR_S_EVIDENCE);
  });
  test('receipts must match the posted state', async () => {
    const e = env();
    const st = signed(e, active(5n, easy));
    const data = closingData({ n: 5n, stateHash: new Uint8Array(32).fill(1), k: 0, lossProven: false });
    const receipts = easy.safe.slice(0, 1).map((t) => P.makeReceipt(easy.layout, easy.C, t, H)!);
    await spend(e, { data, witness: { mode: 'receipts', state: st.state, receipts }, closing: { data } }).verifyFailure(PS.ERR_S_STATE);
  });
  test('a forged receipt is rejected', async () => {
    const e = env();
    const st = signed(e, active(5n, easy));
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    const forged = { ...P.makeReceipt(easy.layout, easy.C, easy.safe[0], H)!, t: easy.mines[0] };
    await spend(e, { data, witness: { mode: 'receipts', state: st.state, receipts: [forged] }, closing: { data: closingData({ n: 5n, stateHash: st.h, k: 1, lossProven: false }) } }).verifyFailure(
      P.ERR_RECEIPT,
    );
  });
  test('loss proof on Hard', async () => {
    const e = env();
    const st = signed(e, active(5n, hard));
    const data = closingData({ n: 5n, stateHash: st.h, k: 2, lossProven: false });
    const t = hard.mines[0];
    cycles['loss proof'] = await spend(e, {
      data,
      witness: { mode: 'loss', state: st.state, S: hard.S, t, p: hard.picks[t], pickProof: P.pickProof(hard.picks, t, H) },
      closing: { data: closingData({ n: 5n, stateHash: st.h, k: 2, lossProven: true }) },
    }).verifySuccess();
  });
  test('a safe tile is not a loss', async () => {
    const e = env();
    const st = signed(e, active(5n, hard));
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    const t = hard.safe[0];
    await spend(e, {
      data,
      witness: { mode: 'loss', state: st.state, S: hard.S, t, p: hard.picks[t], pickProof: P.pickProof(hard.picks, t, H) },
      closing: { data: closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: true }) },
    }).verifyFailure(P.ERR_NOT_A_MINE);
  });
  test('evidence needs an active round', async () => {
    const e = env();
    const st = signed(e, idle(5n));
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    await spend(e, { data, witness: { mode: 'receipts', state: st.state, receipts: [] }, closing: { data } }).verifyFailure(PS.ERR_S_STATE);
  });
  test('evidence is not accepted on an open session', async () => {
    const e = env();
    const st = signed(e, active(5n, easy));
    await spend(e, { witness: { mode: 'receipts', state: st.state, receipts: [] }, closing: { data: new Uint8Array(42) } }).verifyFailure(PS.ERR_S_MODE);
  });
});

describe('settle after the challenge window', () => {
  const easy = round(2, 4);
  test('active round with receipts pays the round payout', async () => {
    const e = env();
    const s = active(5n, easy);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 3, lossProven: false });
    const player = s.p + P.payout(easy.game.s, 3, 2).payout;
    cycles['settle'] = await spend(e, { data, since: relative(D_CHALLENGE), witness: { mode: 'settle', state: st.state }, player, house: TOTAL - player - FEE }).verifySuccess();
  });
  test('a proven loss gives the escrow to the operator', async () => {
    const e = env();
    const s = active(5n, easy);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 3, lossProven: true });
    await spend(e, { data, since: relative(D_CHALLENGE), witness: { mode: 'settle', state: st.state }, player: s.p, house: TOTAL - s.p - FEE }).verifySuccess();
  });
  test('ignoring the receipts is rejected', async () => {
    const e = env();
    const s = active(5n, easy);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 3, lossProven: false });
    await spend(e, { data, since: relative(D_CHALLENGE), witness: { mode: 'settle', state: st.state }, player: s.p + easy.game.s, house: TOTAL - s.p - easy.game.s - FEE }).verifyFailure(
      PS.ERR_S_PAYOUT,
    );
  });
  test('before the window ends is rejected', async () => {
    const e = env();
    const s = idle(5n);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    await spend(e, { data, since: relative(D_CHALLENGE - 1n), witness: { mode: 'settle', state: st.state }, player: s.p, house: TOTAL - s.p - FEE }).verifyFailure(P.ERR_SINCE);
  });
  test('an absolute since is rejected', async () => {
    const e = env();
    const s = idle(5n);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    await spend(e, { data, since: 0x4000000000000000n | D_CHALLENGE, witness: { mode: 'settle', state: st.state }, player: s.p, house: TOTAL - s.p - FEE }).verifyFailure(P.ERR_SINCE);
  });
  test('a session output in a payout is rejected', async () => {
    const e = env();
    const s = idle(5n);
    const st = signed(e, s);
    const data = closingData({ n: 5n, stateHash: st.h, k: 0, lossProven: false });
    await spend(e, { data, since: relative(D_CHALLENGE), witness: { mode: 'settle', state: st.state }, closing: { data }, player: s.p, house: 0n }).verifyFailure(PS.ERR_S_OUTPUT);
  });
});

describe('malformed', () => {
  test('two session cells in one transaction', async () => {
    const e = env();
    const st = signed(e, { ...idle(1n), final: true });
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: TOTAL - 400n * CKB - FEE, twoSessions: true }).verifyFailure(P.ERR_GROUP);
  });
  test('unknown mode byte', async () => {
    const e = env();
    await spend(e, { witness: Uint8Array.of(0x42, 0) }).verifyFailure(PS.ERR_S_WITNESS);
  });
  test('final state with an active round', async () => {
    const e = env();
    const st = signed(e, { ...active(5n, round(2, 9)), final: true });
    await spend(e, { witness: { mode: 'coop', ...st }, player: 400n * CKB, house: 0n }).verifyFailure(PS.ERR_S_STATE);
  });
});

describe('cycle report', () => {
  test('prints cycles per mode', () => {
    console.table(cycles);
    for (const c of Object.values(cycles)) expect(c).toBeLessThan(70_000_000);
  });
});
