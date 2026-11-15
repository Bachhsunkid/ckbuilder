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
