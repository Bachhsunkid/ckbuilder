// CKB Mines protocol library.
// Pure TypeScript with no runtime dependencies, so the same code runs in the
// on-chain script (ckb-js-vm / QuickJS), the game server (Node) and the browser.
// The hash function is injected by the caller: CKB blake2b-256 everywhere.

export type Hash = (data: Uint8Array) => Uint8Array;

export const TILES = 9;
export const TREE_LEAVES = 16;
export const TREE_DEPTH = 4;
export const HASH_LEN = 32;
export const SHANNONS_PER_CKB = 100_000_000n;
/** Smallest standalone cell (secp256k1 lock, no data) in shannons. */
export const MIN_CELL = 61n * SHANNONS_PER_CKB;
export const MINES_BY_DIFFICULTY = { easy: 2, medium: 3, hard: 4 } as const;
export type Difficulty = keyof typeof MINES_BY_DIFFICULTY;

/** Relative, timestamp-metric `since` flags (bit 63 relative, bits 61-62 = 0b10 timestamp). */
export const SINCE_RELATIVE_TIMESTAMP = 0xc000000000000000n;
export const SINCE_FLAGS_MASK = 0xe000000000000000n;
export const SINCE_VALUE_MASK = 0x00ffffffffffffffn;

// ---------- bytes ----------

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const TAG_LAYOUT = ascii('mines/layout');
const TAG_TILES = ascii('mines/tiles');
const TAG_SALT = ascii('mines/salt');
const TAG_LEAF = ascii('mines/leaf');
const TAG_PICK = ascii('mines/pick');

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function readU64le(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}

// ---------- shuffles ----------

/**
 * Fisher-Yates permutation of 0..8 driven by one 32-byte hash:
 * step i (from 8 down to 1) uses the little-endian u32 at bytes 4*(8-i).
 */
export function permutation(seedHash: Uint8Array): number[] {
  const p = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = TILES - 1; i > 0; i--) {
    const j = u32le(seedHash, 4 * (TILES - 1 - i)) % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  return p;
}

/** Mine states by layout position (1 = mine). The first `m` entries of the permutation are mines. */
export function layoutStates(S: Uint8Array, m: number, H: Hash): Uint8Array {
  const perm = permutation(H(concat(TAG_LAYOUT, S)));
  const states = new Uint8Array(TILES);
  for (let i = 0; i < m; i++) states[perm[i]] = 1;
  return states;
}

/** pi[t] = layout position behind board tile t, from the player's seed C. */
export function tileMap(C: Uint8Array, H: Hash): number[] {
  return permutation(H(concat(TAG_TILES, C)));
}

// ---------- leaves and Merkle tree ----------

export function salt(S: Uint8Array, j: number, H: Hash): Uint8Array {
  return H(concat(TAG_SALT, S, Uint8Array.of(j)));
}

export function layoutLeaf(saltJ: Uint8Array, j: number, state: number, H: Hash): Uint8Array {
  return H(concat(TAG_LEAF, Uint8Array.of(j, state), saltJ));
}

export function pickLeaf(t: number, p: Uint8Array, H: Hash): Uint8Array {
  return H(concat(TAG_PICK, Uint8Array.of(t), p));
}

function padLeaves(leaves: Uint8Array[]): Uint8Array[] {
  if (leaves.length > TREE_LEAVES) throw new Error('too many leaves');
  const out = leaves.slice();
  while (out.length < TREE_LEAVES) out.push(new Uint8Array(HASH_LEN));
  return out;
}

function levels(leaves: Uint8Array[], H: Hash): Uint8Array[][] {
  const all: Uint8Array[][] = [padLeaves(leaves)];
  while (all[all.length - 1].length > 1) {
    const prev = all[all.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(H(concat(prev[i], prev[i + 1])));
    all.push(next);
  }
  return all;
}

export function merkleRoot(leaves: Uint8Array[], H: Hash): Uint8Array {
  const l = levels(leaves, H);
  return l[l.length - 1][0];
}

export function merkleProof(leaves: Uint8Array[], index: number, H: Hash): Uint8Array[] {
  const l = levels(leaves, H);
  const proof: Uint8Array[] = [];
  let idx = index;
  for (let d = 0; d < TREE_DEPTH; d++) {
    proof.push(l[d][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

export function verifyMerkle(leaf: Uint8Array, index: number, proof: Uint8Array[], root: Uint8Array, H: Hash): boolean {
  if (proof.length !== TREE_DEPTH || index < 0 || index >= TREE_LEAVES) return false;
  let node = leaf;
  let idx = index;
  for (let d = 0; d < TREE_DEPTH; d++) {
    node = idx & 1 ? H(concat(proof[d], node)) : H(concat(node, proof[d]));
    idx >>= 1;
  }
  return bytesEqual(node, root);
}

// ---------- commitments ----------

export interface Layout {
  states: Uint8Array;
  salts: Uint8Array[];
  leaves: Uint8Array[];
  root: Uint8Array;
}

/** Everything the operator derives from its seed S. */
export function buildLayout(S: Uint8Array, m: number, H: Hash): Layout {
  const states = layoutStates(S, m, H);
  const salts: Uint8Array[] = [];
  const leaves: Uint8Array[] = [];
  for (let j = 0; j < TILES; j++) {
    const s = salt(S, j, H);
    salts.push(s);
    leaves.push(layoutLeaf(s, j, states[j], H));
  }
  return { states, salts, leaves, root: merkleRoot(leaves, H) };
}

export function pickRoot(picks: Uint8Array[], H: Hash): Uint8Array {
  if (picks.length !== TILES) throw new Error('need 9 pick secrets');
  return merkleRoot(picks.map((p, t) => pickLeaf(t, p, H)), H);
}

export function pickProof(picks: Uint8Array[], t: number, H: Hash): Uint8Array[] {
  return merkleProof(picks.map((p, i) => pickLeaf(i, p, H)), t, H);
}

// ---------- game math (shannons, BigInt) ----------

export function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i);
  return r;
}

export function validMines(m: number): boolean {
  return m === 2 || m === 3 || m === 4;
}

/** Display-only multiplier C(9,k)/C(9-m,k). Never used for money. */
export function multiplier(k: number, m: number): number {
  return Number(binom(TILES, k)) / Number(binom(TILES - m, k));
}

export interface Payout {
  gross: bigint;
  profit: bigint;
  fee: bigint;
  payout: bigint;
}

/** SPEC section 3. Rounding always against the player. k = 0 refunds the stake. */
export function payout(stake: bigint, k: number, m: number): Payout {
  const gross = (stake * binom(TILES, k)) / binom(TILES - m, k);
  const profit = gross - stake;
  const fee = (profit * 5n + 99n) / 100n;
  return { gross, profit, fee, payout: gross - fee };
}

export function betCapacity(stake: bigint, m: number): bigint {
  return binom(TILES, m) * stake;
}

export function collateral(stake: bigint, m: number): bigint {
  return (binom(TILES, m) - 1n) * stake;
}

/** What path C must leave to the house; below one cell it is forgiven (SPEC 7.3 dust rule). */
export function houseShareOnExit(capacity: bigint, stake: bigint, k: number, m: number): bigint {
  const share = capacity - payout(stake, k, m).payout;
  return share >= MIN_CELL ? share : 0n;
}

// ---------- script args ----------

export interface BetArgs {
  playerLockHash: Uint8Array;
  houseLockHash: Uint8Array;
  R: Uint8Array;
  C: Uint8Array;
  Q: Uint8Array;
  m: number;
  stake: bigint;
  /** seconds, relative to the bet cell's commit block */
  dExit: bigint;
  dForfeit: bigint;
}

export const ARGS_LEN = 32 * 5 + 1 + 8 * 3; // 185

export function encodeArgs(a: BetArgs): Uint8Array {
  for (const f of [a.playerLockHash, a.houseLockHash, a.R, a.C, a.Q]) {
    if (f.length !== HASH_LEN) throw new Error('args field must be 32 bytes');
  }
  return concat(a.playerLockHash, a.houseLockHash, a.R, a.C, a.Q, Uint8Array.of(a.m), u64le(a.stake), u64le(a.dExit), u64le(a.dForfeit));
}

export function decodeArgs(b: Uint8Array): BetArgs | null {
  if (b.length !== ARGS_LEN) return null;
  const f = (i: number) => b.slice(32 * i, 32 * (i + 1));
  return {
    playerLockHash: f(0),
    houseLockHash: f(1),
    R: f(2),
    C: f(3),
    Q: f(4),
    m: b[160],
    stake: readU64le(b, 161),
    dExit: readU64le(b, 169),
    dForfeit: readU64le(b, 177),
  };
}

// ---------- witness (WitnessArgs.lock of the bet cell input) ----------

export interface Receipt {
  /** board tile */
  t: number;
  salt: Uint8Array;
  proof: Uint8Array[];
}

export type Witness =
  | { path: 'A' }
  | { path: 'B'; S: Uint8Array; t: number; p: Uint8Array; pickProof: Uint8Array[] }
  | { path: 'C'; receipts: Receipt[] }
  | { path: 'D' };

const PATH_A = 0;
const PATH_B = 1;
const PATH_C = 2;
const PATH_D = 3;
const PROOF_LEN = TREE_DEPTH * HASH_LEN;
const RECEIPT_LEN = 1 + HASH_LEN + PROOF_LEN;

export function encodeWitness(w: Witness): Uint8Array {
  switch (w.path) {
    case 'A':
      return Uint8Array.of(PATH_A);
    case 'D':
      return Uint8Array.of(PATH_D);
    case 'B':
      return concat(Uint8Array.of(PATH_B), w.S, Uint8Array.of(w.t), w.p, ...w.pickProof);
    case 'C':
      return concat(Uint8Array.of(PATH_C, w.receipts.length), ...w.receipts.map((r) => concat(Uint8Array.of(r.t), r.salt, ...r.proof)));
  }
}

function readProof(b: Uint8Array, off: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let d = 0; d < TREE_DEPTH; d++) out.push(b.slice(off + d * HASH_LEN, off + (d + 1) * HASH_LEN));
  return out;
}

export function decodeWitness(b: Uint8Array): Witness | null {
  if (b.length < 1) return null;
  switch (b[0]) {
    case PATH_A:
      return b.length === 1 ? { path: 'A' } : null;
    case PATH_D:
      return b.length === 1 ? { path: 'D' } : null;
    case PATH_B:
      if (b.length !== 1 + HASH_LEN + 1 + HASH_LEN + PROOF_LEN) return null;
      return { path: 'B', S: b.slice(1, 33), t: b[33], p: b.slice(34, 66), pickProof: readProof(b, 66) };
    case PATH_C: {
      if (b.length < 2) return null;
      const k = b[1];
      if (b.length !== 2 + k * RECEIPT_LEN) return null;
      const receipts: Receipt[] = [];
      for (let i = 0; i < k; i++) {
        const off = 2 + i * RECEIPT_LEN;
        receipts.push({ t: b[off], salt: b.slice(off + 1, off + 33), proof: readProof(b, off + 33) });
      }
      return { path: 'C', receipts };
    }
    default:
      return null;
  }
}

// ---------- evidence checks (shared by the script, the server and the Verify page) ----------

export const OK = 0;
export const ERR_ARGS = 1;
export const ERR_GROUP = 2;
export const ERR_WITNESS = 3;
export const ERR_NO_PLAYER_INPUT = 5;
export const ERR_NO_HOUSE_INPUT = 6;
export const ERR_SINCE = 7;
export const ERR_LAYOUT_ROOT = 8;
export const ERR_PICK_PROOF = 9;
export const ERR_NOT_A_MINE = 10;
export const ERR_RECEIPT = 11;
export const ERR_HOUSE_UNDERPAID = 12;

/** Path B evidence: the seed rebuilds R, the player committed to tile t, and tile t is a mine. */
export function checkLoss(args: BetArgs, w: { S: Uint8Array; t: number; p: Uint8Array; pickProof: Uint8Array[] }, H: Hash): number {
  if (w.t >= TILES) return ERR_PICK_PROOF;
  const layout = buildLayout(w.S, args.m, H);
  if (!bytesEqual(layout.root, args.R)) return ERR_LAYOUT_ROOT;
  if (!verifyMerkle(pickLeaf(w.t, w.p, H), w.t, w.pickProof, args.Q, H)) return ERR_PICK_PROOF;
  const pi = tileMap(args.C, H);
  if (layout.states[pi[w.t]] !== 1) return ERR_NOT_A_MINE;
  return OK;
}

/** Path C evidence: distinct tiles, each with a safe leaf proven against R. Returns k or a negative error. */
export function checkReceipts(args: BetArgs, receipts: Receipt[], H: Hash): number {
  if (receipts.length > TILES - args.m) return -ERR_RECEIPT;
  const pi = tileMap(args.C, H);
  const seen = new Uint8Array(TILES);
  for (const r of receipts) {
    if (r.t >= TILES || seen[r.t]) return -ERR_RECEIPT;
    seen[r.t] = 1;
    const j = pi[r.t];
    if (!verifyMerkle(layoutLeaf(r.salt, j, 0, H), j, r.proof, args.R, H)) return -ERR_RECEIPT;
  }
  return receipts.length;
}

/** Builds the receipt the operator hands out for a safe tile. */
export function makeReceipt(layout: Layout, C: Uint8Array, t: number, H: Hash): Receipt | null {
  const j = tileMap(C, H)[t];
  if (layout.states[j] !== 0) return null;
  return { t, salt: layout.salts[j], proof: merkleProof(layout.leaves, j, H) };
}

// ---------- Verify page ----------

export interface GameRecord {
  args: BetArgs;
  /** operator seed, published at settlement */
  S: Uint8Array;
  /** tiles the player revealed, in order */
  picks: number[];
  /** pick secrets, published by the player's client */
  pickSecrets: Uint8Array[];
  receipts: Receipt[];
  outcome: 'won' | 'lost' | 'exit';
  /** tile that was a mine, for a loss */
  hit?: number;
  /** amount the settlement paid to the player, in shannons */
  paid: bigint;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** The five checks of SPEC section 6, in order. */
export function verifyGame(g: GameRecord, H: Hash): Check[] {
  const { args } = g;
  const layout = buildLayout(g.S, args.m, H);
  const rootOk = bytesEqual(layout.root, args.R);
  let mines = 0;
  for (const s of layout.states) mines += s;
  const qOk = g.pickSecrets.length === TILES && bytesEqual(pickRoot(g.pickSecrets, H), args.Q);
  const k = checkReceipts(args, g.receipts, H);
  const pi = tileMap(args.C, H);
  let lastOk: boolean;
  let lastDetail: string;
  if (g.outcome === 'lost') {
    lastOk = g.hit !== undefined && layout.states[pi[g.hit]] === 1 && g.paid === 0n;
    lastDetail = lastOk ? `tile ${g.hit! + 1} is a mine in the committed layout` : 'the claimed mine is not a mine';
  } else {
    const due = payout(args.stake, Math.max(k, 0), args.m).payout;
    lastOk = k >= 0 && g.paid >= due;
    lastDetail = `rules give ${due} shannons for ${k} safe tiles, settlement paid ${g.paid}`;
  }
  return [
    { name: 'Layout matches R', ok: rootOk, detail: rootOk ? 'rebuilt root equals R' : 'rebuilt root differs from R' },
    { name: `Exactly ${args.m} mines`, ok: rootOk && mines === args.m, detail: `${mines} mines in the layout` },
    { name: 'Picks match Q', ok: qOk, detail: qOk ? 'pick secrets rebuild Q' : 'pick secrets do not rebuild Q' },
    { name: 'Receipts are valid', ok: k >= 0 && k === g.receipts.length, detail: k >= 0 ? `${k} receipts verified` : 'a receipt failed' },
    { name: g.outcome === 'lost' ? 'Loss was legitimate' : 'Payout follows the rules', ok: lastOk, detail: lastDetail },
  ];
}
