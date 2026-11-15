// Offline checks of the session builders: every transaction they build passes the same rule set
// the deployed lock runs (PS.checkSession), and moves exactly the amounts ADR 0001 section 7 gives.
import { ccc } from '@ckb-ccc/core';
import { describe, expect, it } from 'vitest';
import { H, OPERATOR_FEE, P, bytes, lockHash, type CellRef } from '../src/index';
import {
  MIN_SESSION_CAPACITY,
  PS,
  buildCloseTx,
  buildCoopCloseTx,
  buildDepositTx,
  buildSessionLossTx,
  buildSessionReceiptsTx,
  buildSessionSettleTx,
  checkDepositTx,
  checkStateSig,
  decodeSessionLock,
  finalState,
  keyHashOf,
  maxStakeFor,
  recoverKeyHash,
  roundProblem,
  roundState,
  sessionLock,
  sessionLockArgs,
  settledState,
  signState,
  type SessionCell,
  type SignedState,
} from '../src/session';

const CKB = P.SHANNONS_PER_CKB;
const lockOf = (n: number): ccc.Script =>
  ccc.Script.from({ codeHash: `0x${'9b'.repeat(32)}`, hashType: 'type', args: ccc.hexFrom(new Uint8Array(20).fill(n)) });
const playerLock = lockOf(1);
const houseLock = lockOf(2);
const parties = { playerLock, houseLock };
const seed = (n: number) => new Uint8Array(32).fill(n);
const playerKey = seed(11);
const houseKey = seed(12);

const args: PS.SessionArgs = {
  playerLockHash: lockHash(playerLock),
  houseLockHash: lockHash(houseLock),
  playerKeyHash: keyHashOf(playerKey),
  houseKeyHash: keyHashOf(houseKey),
  dChallenge: 180n,
};
const DEPOSIT = 200n * CKB;
const HOUSE = 1250n * CKB;
const T = DEPOSIT + HOUSE;

const both = (s: PS.SessionState): SignedState => {
  const state = PS.encodeState(s);
  return { state, sigP: signState(playerKey, args, state), sigH: signState(houseKey, args, state) };
};

/** What the lock would see when `tx` spends `cell` (its only input). */
function check(tx: ccc.Transaction, cell: SessionCell): number {
  const self = sessionLock(args);
  const sessionOutputs = tx.outputs
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.lock.eq(self))
    .map(({ o, i }) => ({ capacity: o.capacity, data: bytes(tx.outputsData[i]), hasType: !!o.type }));
  const flowTo = (h: Uint8Array) => {
    let f = 0n;
    for (const o of tx.outputs) if (P.bytesEqual(lockHash(o.lock), h)) f += o.capacity;
    if (P.bytesEqual(lockHash(self), h)) f -= cell.capacity;
    return f;
  };
  const witness = bytes(ccc.WitnessArgs.fromBytes(tx.witnesses[0]).lock!);
  return PS.checkSession(
    { lockArgs: sessionLockArgs(args), args, groupInputs: 1, inputCapacity: cell.capacity, inputData: cell.data, since: tx.inputs[0].since, witness, sessionOutputs, flowTo },
    H,
    recoverKeyHash,
  );
}

const outTo = (tx: ccc.Transaction, lock: ccc.Script) => tx.outputs.filter((o) => o.lock.eq(lock)).reduce((a, o) => a + o.capacity, 0n);

function nextCell(tx: ccc.Transaction): SessionCell {
  return { outPoint: { txHash: tx.hash(), index: 0n }, capacity: tx.outputs[0].capacity, args, data: bytes(tx.outputsData[0]) };
}

// a Hard round with a known layout, so we can find safe tiles and mines
const S = seed(50);
const C = seed(51);
const picks = Array.from({ length: 9 }, (_, i) => seed(60 + i));
const m = 4;
const layout = P.buildLayout(S, m, H);
const tiles = P.tileMap(C, H);
const safeTiles = [...Array(9).keys()].filter((t) => layout.states[tiles[t]] === 0);
const mineTile = [...Array(9).keys()].find((t) => layout.states[tiles[t]] !== 0)!;
const stake = 10n * CKB;
const game: PS.SessionGame = { R: layout.root, C, Q: P.pickRoot(picks, H), m, s: stake };

const s0: PS.SessionState = { n: 0n, p: DEPOSIT, h: HOUSE, final: false, game: null };
const s1 = roundState(s0, game);
const open: SessionCell = { outPoint: { txHash: `0x${'ab'.repeat(32)}`, index: 0n }, capacity: T, args, data: new Uint8Array() };

describe('session lock and keys', () => {
  it('round-trips the lock and binds signatures to the session key', () => {
    expect(decodeSessionLock(sessionLock(args))).toEqual(args);
    const st = PS.encodeState(s0);
    expect(checkStateSig(signState(playerKey, args, st), args.playerKeyHash, args, st)).toBe(true);
    expect(checkStateSig(signState(houseKey, args, st), args.playerKeyHash, args, st)).toBe(false);
    const other = { ...args, dChallenge: 181n };
    expect(checkStateSig(signState(playerKey, other, st), args.playerKeyHash, args, st)).toBe(false);
  });
});

describe('deposit', () => {
  const house: CellRef = { outPoint: { txHash: `0x${'cd'.repeat(32)}`, index: 1 }, capacity: 5000n * CKB, lock: houseLock };
  it('locks both deposits and returns house change', () => {
    const tx = buildDepositTx({ args, houses: [house], deposit: DEPOSIT, houseDeposit: HOUSE });
    expect(tx.outputs[0].capacity).toBe(T);
    expect(tx.outputs[1].capacity).toBe(5000n * CKB - HOUSE);
    expect(checkDepositTx(tx, { args, houses: [house], deposit: DEPOSIT, houseDeposit: HOUSE })).toEqual([]);
  });
  it('catches a deposit that shorts the session or the house', () => {
    const tx = buildDepositTx({ args, houses: [house], deposit: DEPOSIT, houseDeposit: HOUSE });
    const short = tx.clone();
    short.outputs[0].capacity -= 1n;
    expect(checkDepositTx(short, { args, houses: [house], deposit: DEPOSIT, houseDeposit: HOUSE }).length).toBeGreaterThan(0);
    const stolen = tx.clone();
    stolen.outputs[1].capacity -= CKB;
    expect(checkDepositTx(stolen, { args, houses: [house], deposit: DEPOSIT, houseDeposit: HOUSE }).length).toBeGreaterThan(0);
  });
  it('merges several house cells', () => {
    const small: CellRef[] = [
      { ...house, outPoint: { txHash: `0x${'e1'.repeat(32)}`, index: 0 }, capacity: 800n * CKB },
      { ...house, outPoint: { txHash: `0x${'e2'.repeat(32)}`, index: 0 }, capacity: 700n * CKB },
    ];
    const tx = buildDepositTx({ args, houses: small, deposit: DEPOSIT, houseDeposit: HOUSE });
    expect(tx.inputs.length).toBe(2);
    expect(tx.outputs[1].capacity).toBe(250n * CKB);
    expect(checkDepositTx(tx, { args, houses: small, deposit: DEPOSIT, houseDeposit: HOUSE })).toEqual([]);
    const dropped = tx.clone();
    dropped.inputs.pop();
    expect(checkDepositTx(dropped, { args, houses: small, deposit: DEPOSIT, houseDeposit: HOUSE }).length).toBeGreaterThan(0);
  });
  it('refuses a session too small to close alone', () => {
    expect(() => buildDepositTx({ args, houses: [house], deposit: 100n * CKB, houseDeposit: MIN_SESSION_CAPACITY - 100n * CKB - 1n })).toThrow();
  });
});

describe('round states', () => {
  it('keeps p + h + escrow equal to the cell', () => {
    expect(s1.p + s1.h + PS.sessionEscrow(game)).toBe(T);
    const won = settledState(s1, P.payout(stake, 2, m).payout);
    expect(won.p + won.h).toBe(T);
    expect(settledState(s1, 0n)).toEqual({ n: 2n, p: DEPOSIT - stake, h: HOUSE + stake, final: false, game: null });
  });
  it('applies the signing rules of ADR section 4.3', () => {
    expect(roundProblem(s0, 4, 10n * CKB)).toBeNull();
    expect(roundProblem({ ...s0, p: 10n * CKB }, 4, 10n * CKB)).toBeNull(); // all in
    expect(roundProblem(s0, 4, DEPOSIT - 30n * CKB)).toMatch(/61 CKB/);
    expect(roundProblem(s0, 4, 11n * CKB)).toMatch(/operator deposit/); // 125 x 11 > 1250
    expect(roundProblem(s1, 2, 10n * CKB)).toMatch(/active/);
    expect(maxStakeFor(s0, 4)).toBe(10n * CKB);
    expect(maxStakeFor(s0, 2)).toBe(HOUSE / 35n);
    expect(maxStakeFor({ ...s0, p: 20n * CKB }, 2)).toBe(20n * CKB);
  });
});

describe('session transactions pass the lock rules', () => {
  it('cooperative close pays both sides at once', () => {
    const won = settledState(s1, P.payout(stake, 3, m).payout);
    const tx = buildCoopCloseTx({ cell: open, parties, signed: both(finalState(won)) });
    expect(check(tx, open)).toBe(P.OK);
    expect(outTo(tx, playerLock)).toBe(won.p);
    expect(outTo(tx, houseLock)).toBe(won.h - OPERATOR_FEE);
  });

  it('a stale close is answered by a later state, then settles to it', () => {
    const close = buildCloseTx({ cell: open, signed: both(s0) });
    expect(check(close, open)).toBe(P.OK);
    const closing = nextCell(close);
    const lost = settledState(s1, 0n);
    const update = buildCloseTx({ cell: closing, signed: both(lost) });
    expect(check(update, closing)).toBe(P.OK);
    const updated = nextCell(update);
    expect(check(buildCloseTx({ cell: updated, signed: both(s1) }), updated)).toBe(PS.ERR_S_NONCE);
    const settle = buildSessionSettleTx({ cell: updated, parties, state: PS.encodeState(lost) });
    expect(check(settle, updated)).toBe(P.OK);
    expect(outTo(settle, playerLock)).toBe(lost.p);
    expect(outTo(settle, houseLock)).toBe(updated.capacity - lost.p - OPERATOR_FEE);
  });

  it('receipts posted on a live round pay the win', () => {
    const closing = nextCell(buildCloseTx({ cell: open, signed: both(s1) }));
    const state = PS.encodeState(s1);
    const receipts = safeTiles.slice(0, 2).map((t) => P.makeReceipt(layout, C, t, H)!);
    const post = buildSessionReceiptsTx({ cell: closing, state, receipts });
    expect(check(post, closing)).toBe(P.OK);
    const posted = nextCell(post);
    const settle = buildSessionSettleTx({ cell: posted, parties, state });
    expect(check(settle, posted)).toBe(P.OK);
    expect(outTo(settle, playerLock)).toBe(s1.p + P.payout(stake, 2, m).payout);
  });

  it('a loss proof beats receipts', () => {
    const closing = nextCell(buildCloseTx({ cell: open, signed: both(s1) }));
    const state = PS.encodeState(s1);
    const receipts = [P.makeReceipt(layout, C, safeTiles[0], H)!];
    const posted = nextCell(buildSessionReceiptsTx({ cell: closing, state, receipts }));
    const loss = buildSessionLossTx({ cell: posted, state, S, t: mineTile, p: picks[mineTile], pickProof: P.pickProof(picks, mineTile, H) });
    expect(check(loss, posted)).toBe(P.OK);
    const proven = nextCell(loss);
    const settle = buildSessionSettleTx({ cell: proven, parties, state });
    expect(check(settle, proven)).toBe(P.OK);
    expect(outTo(settle, playerLock)).toBe(s1.p);
  });

  it('settle before the window is refused by the lock', () => {
    const closing = nextCell(buildCloseTx({ cell: open, signed: both(s0) }));
    const settle = buildSessionSettleTx({ cell: closing, parties, state: PS.encodeState(s0) });
    settle.inputs[0].since = P.SINCE_RELATIVE_TIMESTAMP | 179n;
    expect(check(settle, closing)).toBe(P.ERR_SINCE);
  });

  it('refuses to build a payout to the wrong wallet', () => {
    expect(() => buildCoopCloseTx({ cell: open, parties: { playerLock: houseLock, houseLock }, signed: both(finalState(s0)) })).toThrow();
  });
});
