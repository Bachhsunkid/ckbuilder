// The server co-signs a cash-out only if the player returns the transaction the server built.
import { ccc } from '@ckb-ccc/core';
import { betLock, buildCashOutTx, lockHash, P, H } from '@ckb-mines/chain';
import { describe, expect, it } from 'vitest';
import { sameSettlement } from '../src/bets';

const CKB = 100_000_000n;
const lockOf = (n: number) => ccc.Script.from({ codeHash: `0x${'9b'.repeat(32)}`, hashType: 'type', args: ccc.hexFrom(new Uint8Array(20).fill(n)) });
const op = (n: number) => ({ txHash: ccc.hexFrom(new Uint8Array(32).fill(n)), index: 0 });

function draft() {
  const playerLock = lockOf(1);
  const houseLock = lockOf(2);
  const args: P.BetArgs = {
    playerLockHash: lockHash(playerLock),
    houseLockHash: lockHash(houseLock),
    R: P.buildLayout(new Uint8Array(32).fill(7), 2, H).root,
    C: new Uint8Array(32).fill(8),
    Q: new Uint8Array(32).fill(9),
    m: 2,
    stake: 20n * CKB,
    dExit: 900n,
    dForfeit: 86_400n,
  };
  return buildCashOutTx({
    bet: { outPoint: op(3), capacity: P.betCapacity(args.stake, 2), lock: betLock(args), args },
    house: { outPoint: op(1), capacity: 3000n * CKB, lock: houseLock },
    player: { outPoint: op(2), capacity: 100n * CKB, lock: playerLock },
    k: 2,
  });
}

const copy = (tx: ccc.Transaction) => ccc.Transaction.from(tx.clone());

describe('sameSettlement', () => {
  it('accepts the same transaction, even with extra cell deps and witnesses from the wallet', () => {
    const d = draft();
    const signed = copy(d);
    signed.cellDeps.push(ccc.CellDep.from({ outPoint: op(9), depType: 'depGroup' }));
    signed.witnesses.push('0x1234');
    expect(sameSettlement(d, signed)).toBeNull();
  });

  it('rejects a bigger payout to the player', () => {
    const d = draft();
    const s = copy(d);
    s.outputs[0].capacity += 1n;
    expect(sameSettlement(d, s)).toBe('output 0 differs');
  });

  it('rejects a payout redirected to another lock', () => {
    const d = draft();
    const s = copy(d);
    s.outputs[0].lock = lockOf(5);
    expect(sameSettlement(d, s)).toBe('output 0 differs');
  });

  it('rejects swapped inputs, extra outputs and a changed bet witness', () => {
    const d = draft();
    const a = copy(d);
    a.inputs[2].previousOutput = ccc.OutPoint.from(op(7));
    expect(sameSettlement(d, a)).toBe('input 2 differs');

    const b = copy(d);
    b.outputs.push(ccc.CellOutput.from({ lock: lockOf(5), capacity: 61n * CKB }));
    b.outputsData.push('0x');
    expect(sameSettlement(d, b)).toBe('outputs differ');

    const c = copy(d);
    c.witnesses[0] = ccc.hexFrom(ccc.WitnessArgs.from({ lock: '0x03' }).toBytes());
    expect(sameSettlement(d, c)).toBe('bet witness differs');

    const e = copy(d);
    e.outputs[1].type = lockOf(6);
    expect(sameSettlement(d, e)).toBe('output 1 differs');
  });
});
