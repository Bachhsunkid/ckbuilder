import { describe, expect, test } from 'vitest';
import { ccc } from '@ckb-ccc/core';
import * as p from '../src/index';

const H: p.Hash = (d) => new Uint8Array(ccc.bytesFrom(ccc.hashCkb(d)));
const seed = (n: number) => H(Uint8Array.of(n));
const CKB = p.SHANNONS_PER_CKB;

function game(m: number, n = 1) {
  const S = seed(100 + n);
  const C = seed(200 + n);
  const picks = Array.from({ length: 9 }, (_, t) => seed(300 + 10 * n + t));
  const layout = p.buildLayout(S, m, H);
  const args: p.BetArgs = {
    playerLockHash: seed(1),
    houseLockHash: seed(2),
    R: layout.root,
    C,
    Q: p.pickRoot(picks, H),
    m,
    stake: 25n * CKB,
    dExit: 900n,
    dForfeit: 86400n,
  };
  const pi = p.tileMap(C, H);
  const safeTiles = [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 0);
  const mineTiles = [...Array(9).keys()].filter((t) => layout.states[pi[t]] === 1);
  return { S, C, picks, layout, args, pi, safeTiles, mineTiles };
}

describe('game math (SPEC section 3)', () => {
  test('SPEC example: stake 100, Easy, k=3 pays 233', () => {
    expect(p.payout(100n * CKB, 3, 2)).toEqual({ gross: 240n * CKB, profit: 140n * CKB, fee: 7n * CKB, payout: 233n * CKB });
  });
  test('rounding case: 25 CKB, Easy, k=1 pays 31.79 CKB', () => {
    const r = p.payout(25n * CKB, 1, 2);
    expect(r).toEqual({ gross: 3_214_285_714n, profit: 714_285_714n, fee: 35_714_286n, payout: 3_178_571_428n }); // 31.79 CKB at two decimals
  });
  test('k = 0 refunds the stake', () => {
    expect(p.payout(10n * CKB, 0, 4).payout).toBe(10n * CKB);
  });
  test('multiplier table', () => {
    const table = [2, 3, 4].map((m) => Array.from({ length: 9 - m }, (_, i) => Number(p.multiplier(i + 1, m).toFixed(2))));
    expect(table).toEqual([
      [1.29, 1.71, 2.4, 3.6, 6, 12, 36],
      [1.5, 2.4, 4.2, 8.4, 21, 84],
      [1.8, 3.6, 8.4, 25.2, 126],
    ]);
  });
  test('the bet cell holds exactly the best case', () => {
    for (const m of [2, 3, 4]) {
      const stake = 13n * CKB;
      expect(p.payout(stake, 9 - m, m).gross).toBe(p.betCapacity(stake, m));
      expect(p.collateral(stake, m) + stake).toBe(p.betCapacity(stake, m));
    }
  });
});

describe('shuffles and layout', () => {
  test('permutation is a permutation and deterministic', () => {
    for (let n = 0; n < 50; n++) {
      const perm = p.permutation(seed(n));
      expect([...perm].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(p.permutation(seed(n))).toEqual(perm);
    }
  });
  test('layout has exactly m mines', () => {
    for (const m of [2, 3, 4]) {
      for (let n = 0; n < 20; n++) {
        expect(p.layoutStates(seed(n), m, H).reduce((a, b) => a + b, 0)).toBe(m);
      }
    }
  });
  test('mine positions are roughly uniform over 9000 seeds', () => {
    const counts = new Array(9).fill(0);
    for (let n = 0; n < 9000; n++) p.layoutStates(H(ccc.numLeToBytes(n, 4)), 2, H).forEach((s, j) => (counts[j] += s));
    for (const c of counts) expect(Math.abs(c - 2000)).toBeLessThan(200);
  });
});

describe('Merkle tree', () => {
  test('every proof verifies and a wrong index fails', () => {
    const leaves = Array.from({ length: 9 }, (_, i) => seed(i));
    const root = p.merkleRoot(leaves, H);
    for (let i = 0; i < 9; i++) {
      const proof = p.merkleProof(leaves, i, H);
      expect(p.verifyMerkle(leaves[i], i, proof, root, H)).toBe(true);
      expect(p.verifyMerkle(leaves[i], (i + 1) % 9, proof, root, H)).toBe(false);
    }
  });
});

describe('encoding', () => {
  test('args round trip and length 185', () => {
    const { args } = game(3);
    const enc = p.encodeArgs(args);
    expect(enc.length).toBe(185);
    expect(p.decodeArgs(enc)).toEqual(args);
  });
  test('witness round trip for every path', () => {
    const g = game(2);
    const receipts = g.safeTiles.slice(0, 3).map((t) => p.makeReceipt(g.layout, g.C, t, H)!);
    const t = g.mineTiles[0];
    const ws: p.Witness[] = [
      { path: 'A' },
      { path: 'D' },
      { path: 'B', S: g.S, t, p: g.picks[t], pickProof: p.pickProof(g.picks, t, H) },
      { path: 'C', receipts },
      { path: 'C', receipts: [] },
    ];
    for (const w of ws) expect(p.decodeWitness(p.encodeWitness(w))).toEqual(w);
    expect(p.decodeWitness(Uint8Array.of(9))).toBeNull();
    expect(p.decodeWitness(Uint8Array.of(2, 1))).toBeNull();
  });
});

describe('evidence checks', () => {
  for (const m of [2, 3, 4]) {
    test(`m=${m}: honest loss passes, every forgery fails`, () => {
      const g = game(m, m);
      const t = g.mineTiles[0];
      const loss = { S: g.S, t, p: g.picks[t], pickProof: p.pickProof(g.picks, t, H) };
      expect(p.checkLoss(g.args, loss, H)).toBe(p.OK);

      const safe = g.safeTiles[0];
      expect(p.checkLoss(g.args, { ...loss, t: safe, p: g.picks[safe], pickProof: p.pickProof(g.picks, safe, H) }, H)).toBe(p.ERR_NOT_A_MINE);
      expect(p.checkLoss(g.args, { ...loss, S: seed(999) }, H)).toBe(p.ERR_LAYOUT_ROOT);
      expect(p.checkLoss({ ...g.args, m: m === 4 ? 3 : m + 1 }, loss, H)).toBe(p.ERR_LAYOUT_ROOT);
      expect(p.checkLoss(g.args, { ...loss, p: seed(998) }, H)).toBe(p.ERR_PICK_PROOF);
    });

    test(`m=${m}: receipts for every safe tile pass, forged or duplicate ones fail`, () => {
      const g = game(m, 10 + m);
      const receipts = g.safeTiles.map((t) => p.makeReceipt(g.layout, g.C, t, H)!);
      expect(p.checkReceipts(g.args, receipts, H)).toBe(9 - m);
      expect(p.makeReceipt(g.layout, g.C, g.mineTiles[0], H)).toBeNull();
      expect(p.checkReceipts(g.args, [receipts[0], receipts[0]], H)).toBe(-p.ERR_RECEIPT);
      expect(p.checkReceipts(g.args, [{ ...receipts[0], t: g.mineTiles[0] }], H)).toBe(-p.ERR_RECEIPT);
      expect(p.checkReceipts(g.args, [{ ...receipts[0], salt: seed(5) }], H)).toBe(-p.ERR_RECEIPT);
    });
  }
  test('rigged layout is caught by the Verify page', () => {
    const g = game(2, 42);
    const t = g.safeTiles[0];
    const record: p.GameRecord = {
      args: g.args,
      S: g.S,
      picks: [t],
      pickSecrets: g.picks,
      receipts: [p.makeReceipt(g.layout, g.C, t, H)!],
      outcome: 'won',
      paid: p.payout(g.args.stake, 1, 2).payout,
    };
    expect(p.verifyGame(record, H).every((c) => c.ok)).toBe(true);
    const rigged = p.verifyGame({ ...record, S: seed(7) }, H);
    expect(rigged[0].ok).toBe(false);
  });
});

describe('golden vectors (also checked inside ckb-js-vm)', () => {
  test('fixed seed', () => {
    const g = game(3, 7);
    expect(p.toHex(g.layout.root)).toMatchSnapshot();
    expect(Array.from(g.layout.states)).toMatchSnapshot();
    expect(g.pi).toMatchSnapshot();
  });
});
