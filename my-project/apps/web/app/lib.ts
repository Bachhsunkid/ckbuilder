import * as P from '@ckb-mines/protocol';
import type { GameState } from '@ckb-mines/chain/player';
import type { SessionRecord } from '@ckb-mines/chain/session-player';

export const API = process.env.NEXT_PUBLIC_API ?? 'http://localhost:8787';
export const EXPLORER = 'https://testnet.explorer.nervos.org';
export const FAUCET = 'https://faucet.nervos.org';
export const CKB = 100_000_000n;

export const DIFFICULTY: Record<number, string> = { 2: 'Easy', 3: 'Medium', 4: 'Hard' };

/** 1234567890n shannons → "12.35" */
export function ckb(shannons: bigint | string, digits = 2): string {
  const v = Number(BigInt(shannons)) / 1e8;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function short(h?: string | null): string {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '';
}

export function mult(k: number, m: number): string {
  return `${P.multiplier(k, m).toFixed(2)}×`;
}

export interface ServerConfig {
  houseLock: unknown;
  tPlay: number;
  dExit: string;
  dForfeit: string;
  minStake: string;
  maxCollateral: string;
}

export async function getConfig(): Promise<ServerConfig> {
  const r = await fetch(`${API}/api/config`);
  if (!r.ok) throw new Error(`server answered ${r.status}`);
  return r.json();
}

/** One line of the printed receipt. "chain" = on-chain fact, "off" = between you and the operator, "warn" = needs attention. */
export interface LogLine {
  text: string;
  kind: 'chain' | 'off' | 'warn';
  hash?: string;
}

export interface SavedGame {
  state: GameState;
  log: LogLine[];
  savedAt: number;
}

// Receipts and pick secrets live only here: they are what lets you exit alone or verify later.
const KEY = 'ckb-mines/games/v1';

export function loadGames(): SavedGame[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveGame(g: SavedGame) {
  try {
    const all = loadGames().filter((x) => x.state.betId !== g.state.betId);
    all.unshift({ ...g, savedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 100)));
  } catch {
    // storage blocked: the game still works, but cannot be resumed after a reload
  }
}

export const ACTIVE = new Set(['opening', 'open']);

// ---------- sessions (ADR 0001) ----------

export interface SessionConfig {
  dChallenge: string;
  idle: number;
  /** seconds the operator holds the table while the wallet signs the deposit (older servers omit it) */
  signWithin?: number;
  minDeposit: string;
  maxDeposit: string;
  minStake: string;
  maxBet: string;
  houseKeyHash: string;
}

export async function getSessionConfig(): Promise<SessionConfig> {
  const r = await fetch(`${API}/api/config`);
  if (!r.ok) throw new Error(`server answered ${r.status}`);
  return (await r.json()).session;
}

// The session key, every co-signed state and the receipts live only here: they are what lets you
// close and collect without the operator. Losing them means trusting the operator to close fairly.
const SESSIONS_KEY = 'ckb-mines/sessions/v1';

export function loadSessions(): SessionRecord[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveSession(rec: SessionRecord) {
  try {
    const all = loadSessions().filter((x) => x.id !== rec.id);
    all.unshift(rec);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all.slice(0, 50)));
  } catch {
    // storage blocked: play continues, but a reload loses the ability to close alone
  }
}

/** A downloadable copy of the session record: the backup ADR 0001 section 8 asks for. */
export function sessionBackupUrl(rec: SessionRecord): string {
  return URL.createObjectURL(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }));
}

/** Turns SDK, wallet and server errors into one sentence a player can act on. */
export function friendlyError(e: unknown): string {
  const raw = String((e as Error)?.message ?? e).replace(/^Error: /, '');
  if (/user (rejected|denied|cancel)|cancell?ed|rejected by user|popup closed|window closed/i.test(raw)) return 'You cancelled the signature in your wallet. Nothing was sent.';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'Cannot reach the game server. Check your connection and try again; your session is saved in this browser.';
  if (/: 503 |house cell/i.test(raw)) return 'All tables are taken right now. Try again in a minute.';
  if (/: 429 |too many requests/i.test(raw)) return 'Too many requests from your connection. Wait a minute and try again.';
  if (/session is expired|session \S+ expired/i.test(raw)) return 'The deposit was not signed in time, so the operator freed your table. Nothing was sent: open the session again.';
  if (/insufficient|not enough capacity/i.test(raw)) return 'Your wallet does not hold enough CKB for the deposit plus the fee. Get more from the faucet.';
  const api = raw.match(/^(?:GET|POST) \S+: \d{3} (.+)$/s);
  const msg = api ? api[1] : raw;
  const out = msg.charAt(0).toUpperCase() + msg.slice(1);
  return out.length > 240 ? `${out.slice(0, 240)}…` : out;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** First-visit guide: hidden once the player has opened a session in this browser. */
const GUIDE_KEY = 'ckb-mines/guide-seen';
export function guideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}
export function markGuideSeen() {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    // storage blocked: the guide just stays open
  }
}
