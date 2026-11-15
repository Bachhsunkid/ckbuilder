// Offline checks of the transaction builders: who gets how much on every path,
// and that a tampered bet transaction is caught before anyone signs it.
import { ccc } from '@ckb-ccc/core';
import { describe, expect, it } from 'vitest';
import {
  H,
  OPERATOR_FEE,
  P,
  argsFromJson,
  argsToJson,
  betLock,
  buildBetTx,
  buildCashOutTx,
  buildExitTx,
  buildForfeitTx,
  checkBetTx,
  decodeBetLock,
  lockHash,
  netFlow,
  type BetCell,
  type CellRef,
} from '../src/index';

const CKB = 100_000_000n;
const lockOf = (n: number): ccc.Script =>
  ccc.Script.from({ codeHash: `0x${'9b'.repeat(32)}`, hashType: 'type', args: ccc.hexFrom(new Uint8Array(20).fill(n)) });
const playerLock = lockOf(1);
const houseLock = lockOf(2);
const op = (n: number) => ({ txHash: ccc.hexFrom(new Uint8Array(32).fill(n)), index: 0 });

function setup(m = 2, stake = 20n * CKB) {
  const S = new Uint8Array(32).fill(7);
  const C = new Uint8Array(32).fill(8);
  const picks = Array.from({ length: 9 }, (_, i) => new Uint8Array(32).fill(100 + i));
  const layout = P.buildLayout(S, m, H);
  const args: P.BetArgs = {
    playerLockHash: lockHash(playerLock),
    houseLockHash: lockHash(houseLock),
    R: layout.root,
    C,
    Q: P.pickRoot(picks, H),
    m,
    stake,
    dExit: 900n,
    dForfeit: 86_400n,
  };
  const house: CellRef = { outPoint: op(1), capacity: 3000n * CKB, lock: houseLock };
  const player: CellRef = { outPoint: op(2), capacity: 100n * CKB, lock: playerLock };
  const bet: BetCell = { outPoint: op(3), capacity: P.betCapacity(stake, m), lock: betLock(args), args };
  // receipts for the first k safe tiles, as the server would issue them
  const pi = P.tileMap(C, H);
  const safeTiles = [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 0);
  const receipts = (k: number) => safeTiles.slice(0, k).map((t) => P.makeReceipt(layout, C, t, H)!);
  return { args, house, player, bet, receipts };
}

describe('bet lock', () => {
  it('round-trips args through the lock script', () => {
    const { args } = setup();
    const back = decodeBetLock(betLock(args))!;
    expect(P.encodeArgs(back)).toEqual(P.encodeArgs(args));
    expect(P.encodeArgs(argsFromJson(argsToJson(args)))).toEqual(P.encodeArgs(args));
  });
  it('rejects a lock that is not a Mines bet', () => {
    expect(decodeBetLock(playerLock)).toBeNull();
  });
});

describe('bet transaction', () => {
  it('locks C(9,m) x stake and returns the rest to the house', () => {
    const { args, house } = setup(3, 15n * CKB);
    const tx = buildBetTx({ args, house, fee: 0n });
    expect(tx.outputs[0].capacity).toBe(84n * 15n * CKB);
    expect(tx.outputs[1].capacity).toBe(house.capacity - 83n * 15n * CKB);
    expect(checkBetTx(tx, { args, house, fee: 0n })).toEqual([]);
  });

  it('refuses a house cell that cannot cover the collateral', () => {
    const { args } = setup(4, 20n * CKB);
    expect(() => buildBetTx({ args, house: { outPoint: op(1), capacity: 2000n * CKB, lock: houseLock }, fee: 0n })).toThrow();
  });

  it('catches every kind of tampering', () => {
    const { args, house } = setup();
    const o = { args, house, fee: 0n };
    const smaller = buildBetTx(o);
    smaller.outputs[0].capacity -= 1n;
    expect(checkBetTx(smaller, o)).toContain('output 0 is not the expected bet cell');

    const otherLock = buildBetTx(o);
    otherLock.outputs[0].lock = betLock({ ...args, m: 3 });
    expect(checkBetTx(otherLock, o)).toContain('output 0 is not the expected bet cell');

    const skim = buildBetTx(o);
    skim.outputs[1].capacity -= CKB;
    expect(checkBetTx(skim, o)).toContain('output 1 is not the expected house change');

    const withData = buildBetTx(o);
    withData.outputsData[0] = '0x01';
    expect(checkBetTx(withData, o)).toContain('bet and change outputs must have no data');

    const noHouse = buildBetTx(o);
    noHouse.inputs = [];
    expect(checkBetTx(noHouse, o)).toContain('house cell must be spent exactly once');
  });
});

describe('settlements', () => {
  it('cash-out pays exactly the rules to the player, house pays the fee', () => {
    const { bet, house, player } = setup(2, 25n * CKB);
    const tx = buildCashOutTx({ bet, house, player, k: 1 });
    // SPEC rounding case: 25 CKB, Easy, one safe tile
    expect(netFlow(tx, playerLock)).toBe(3_178_571_428n);
    expect(netFlow(tx, houseLock)).toBe(bet.capacity - 3_178_571_428n - OPERATOR_FEE);
    expect(tx.inputs[0].previousOutput.eq(ccc.OutPoint.from(bet.outPoint))).toBe(true);
  });

  it('cash-out conserves capacity on every k', () => {
    const { bet, house, player, args } = setup(4, 20n * CKB);
    for (let k = 1; k <= 9 - args.m; k++) {
      const tx = buildCashOutTx({ bet, house, player, k });
      const ins = bet.capacity + house.capacity + player.capacity;
      const outs = tx.outputs.reduce((s, o) => s + o.capacity, 0n);
      expect(ins - outs).toBe(OPERATOR_FEE);
    }
  });

  it('exit splits by the receipts and the player pays the fee', () => {
    const { bet, player, args, receipts } = setup(2, 20n * CKB);
    for (const k of [0, 1, 3]) {
      const tx = buildExitTx({ bet, player, houseLock, receipts: receipts(k) });
      const houseDue = P.houseShareOnExit(bet.capacity, args.stake, k, args.m);
      expect(netFlow(tx, playerLock)).toBe(bet.capacity - houseDue - OPERATOR_FEE);
      expect(netFlow(tx, playerLock) + OPERATOR_FEE).toBeGreaterThanOrEqual(P.payout(args.stake, k, args.m).payout);
      expect(tx.inputs[0].since).toBe(P.SINCE_RELATIVE_TIMESTAMP | args.dExit);
      expect(P.checkReceipts(args, receipts(k), H)).toBe(k);
    }
  });

  it('forfeit is time-locked by D_forfeit and goes to the house', () => {
    const { bet, house, args } = setup();
    const tx = buildForfeitTx({ bet, house });
    expect(tx.inputs[0].since).toBe(P.SINCE_RELATIVE_TIMESTAMP | args.dForfeit);
    expect(netFlow(tx, houseLock)).toBe(bet.capacity - OPERATOR_FEE);
  });
});
