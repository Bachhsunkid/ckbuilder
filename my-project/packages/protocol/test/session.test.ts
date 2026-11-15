import { ccc } from '@ckb-ccc/core';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index';
import * as PS from '../src/session';

const H: P.Hash = (d) => new Uint8Array(ccc.bytesFrom(ccc.hashCkb(d)));
const CKB = P.SHANNONS_PER_CKB;
const b = (n: number, len = 32) => new Uint8Array(len).fill(n);

const game: PS.SessionGame = { R: b(1), C: b(2), Q: b(3), m: 3, s: 15n * CKB };

describe('session encoding', () => {
  it('round-trips args', () => {
    const a: PS.SessionArgs = { playerLockHash: b(4), houseLockHash: b(5), playerKeyHash: b(6, 20), houseKeyHash: b(7, 20), dChallenge: 86_400n };
    const enc = PS.encodeSessionArgs(a);
    expect(enc.length).toBe(PS.SESSION_ARGS_LEN);
    expect(PS.decodeSessionArgs(enc)).toEqual(a);
    expect(PS.decodeSessionArgs(enc.slice(1))).toBeNull();
  });

  it('round-trips states with and without a round', () => {
    for (const s of [
      { n: 0n, p: 400n * CKB, h: 2600n * CKB, final: false, game: null },
      { n: 7n, p: 385n * CKB, h: 1361n * CKB, final: false, game },
      { n: 9n, p: 1n, h: 2n, final: true, game: null },
    ] as PS.SessionState[]) {
      expect(PS.decodeState(PS.encodeState(s))).toEqual(s);
    }
  });

  it('rejects malformed states', () => {
    const enc = PS.encodeState({ n: 1n, p: 1n, h: 1n, final: false, game });
    expect(PS.decodeState(enc.slice(0, -1))).toBeNull();
    const badFlags = enc.slice();
    badFlags[24] = 4;
    expect(PS.decodeState(badFlags)).toBeNull();
    const noGameFlag = enc.slice();
    noGameFlag[24] = 0;
    expect(PS.decodeState(noGameFlag)).toBeNull();
  });

  it('round-trips closing records and witnesses', () => {
    const c: PS.Closing = { n: 12n, stateHash: b(9), k: 3, lossProven: true };
    expect(PS.decodeClosing(PS.encodeClosing(c))).toEqual(c);
    const state = PS.encodeState({ n: 1n, p: 1n, h: 1n, final: false, game });
    const w: PS.SessionWitness = { mode: 'close', state, sigP: b(1, 65), sigH: b(2, 65) };
    expect(PS.decodeSessionWitness(PS.encodeSessionWitness(w))).toEqual(w);
    expect(PS.decodeSessionWitness(PS.encodeSessionWitness({ mode: 'settle', state }))).toEqual({ mode: 'settle', state });
  });

  it('binds the state hash to the session lock args', () => {
    const state = PS.encodeState({ n: 1n, p: 1n, h: 1n, final: false, game: null });
    expect(PS.stateHash(b(1, 147), state, H)).not.toEqual(PS.stateHash(b(2, 147), state, H));
  });
});

describe('session shares', () => {
  const T = 3000n * CKB;
  it('pays the player its balance plus the round payout', () => {
    const s: PS.SessionState = { n: 3n, p: 385n * CKB, h: 0n, final: false, game };
    const due = s.p + P.payout(game.s, 2, 3).payout;
    expect(PS.sessionShares(s, T, 2, false)).toEqual({ player: due, house: T - due, playerPaysFee: false });
    expect(PS.sessionShares(s, T, 2, true)).toEqual({ player: s.p, house: T - s.p, playerPaysFee: false });
  });
  it('forgives player dust to the operator', () => {
    expect(PS.sessionShares({ n: 1n, p: 60n * CKB, h: 0n, final: true, game: null }, T, 0, false)).toEqual({ player: 0n, house: T, playerPaysFee: false });
  });
  it('gives the player everything when the operator share could not be a cell', () => {
    expect(PS.sessionShares({ n: 1n, p: T - 30n * CKB, h: 0n, final: true, game: null }, T, 0, false)).toEqual({ player: T, house: 0n, playerPaysFee: true });
  });
  it('refuses a state that claims more than the cell holds', () => {
    expect(PS.sessionShares({ n: 1n, p: T + 1n, h: 0n, final: true, game: null }, T, 0, false)).toBeNull();
  });
});
