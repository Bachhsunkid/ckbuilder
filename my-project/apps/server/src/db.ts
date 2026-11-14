import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { config } from './config';

// bigint columns (shannons) come back as strings; callers convert with BigInt().
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function migrate() {
  const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../sql/schema.sql'), 'utf8');
  await pool.query(sql);
}

export interface BetRow {
  id: string;
  status: string;
  m: number;
  stake: string;
  player_lock: { codeHash: string; hashType: string; args: string };
  player_lock_hash: string;
  seed_s: string;
  root_r: string;
  seed_c: string | null;
  root_q: string | null;
  d_exit: string;
  d_forfeit: string;
  args: import('@ckb-mines/chain').BetArgsJson | null;
  house_in: string | null;
  bet_tx: string | null;
  capacity: string | null;
  opened_at: Date | null;
  settle_tx: string | null;
  settle_path: string | null;
  settle_house_in: string | null;
  payout: string | null;
  hit_tile: number | null;
  error: string | null;
  settle_draft: object | null;
  created_at: Date;
  updated_at: Date;
}

export async function getBet(id: string): Promise<BetRow | null> {
  const r = await pool.query<BetRow>('select * from bets where id = $1', [id]);
  return r.rows[0] ?? null;
}

const COLUMNS = new Set([
  'status', 'seed_c', 'root_q', 'args', 'house_in', 'bet_tx', 'capacity', 'opened_at', 'settle_tx',
  'settle_path', 'settle_house_in', 'payout', 'hit_tile', 'error', 'settle_draft',
]);

/** Updates a bet; with `fromStatus` the update only applies if the bet is still in that status. */
export const updateBet = (id: string, fields: Record<string, unknown>, fromStatus?: string | string[]) => updateRow('bets', COLUMNS, id, fields, fromStatus);

async function updateRow(
  table: 'bets' | 'sessions' | 'session_rounds',
  allowed: Set<string>,
  id: string,
  fields: Record<string, unknown>,
  fromStatus?: string | string[],
): Promise<boolean> {
  const keys = Object.keys(fields);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`unknown column ${k}`);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const encode = (v: unknown) =>
    typeof v === 'bigint' ? String(v) : v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  const values: unknown[] = [id, ...keys.map((k) => encode(fields[k]))];
  let where = 'id = $1';
  if (fromStatus !== undefined) {
    values.push(Array.isArray(fromStatus) ? fromStatus : [fromStatus]);
    where += ` and status = any($${values.length})`;
  }
  const r = await pool.query(`update ${table} set ${sets.join(', ')}, updated_at = now() where ${where}`, values);
  return (r.rowCount ?? 0) > 0;
}

// ---------- sessions (ADR 0001) ----------

export interface SessionRow {
  id: string;
  status: string;
  player_lock: { codeHash: string; hashType: string; args: string };
  player_lock_hash: string;
  args: import('@ckb-mines/chain/session').SessionArgsJson;
  deposit: string;
  house_deposit: string;
  house_in: string | null;
  deposit_tx: string | null;
  cell: string | null;
  cell_at: Date | null;
  /** sigP is null until the player sends it with the signed deposit */
  state: { state: string; sigP: string | null; sigH: string };
  pending: { n: string; state: string; sigH: string } | null;
  chain_tx: string | null;
  close_tx: string | null;
  paid_player: string | null;
  last_activity: Date;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RoundRow {
  id: string;
  session_id: string;
  status: string;
  m: number;
  stake: string;
  seed_s: string;
  root_r: string;
  seed_c: string | null;
  root_q: string | null;
  n: string | null;
  k: number | null;
  paid: string | null;
  hit_tile: number | null;
  loss: { t: number; p: string; proof: string[] } | null;
  created_at: Date;
  updated_at: Date;
}

const SESSION_COLUMNS = new Set([
  'status', 'house_in', 'deposit_tx', 'cell', 'cell_at', 'state', 'pending', 'chain_tx', 'close_tx', 'paid_player', 'last_activity', 'error',
]);
const ROUND_COLUMNS = new Set(['status', 'seed_c', 'root_q', 'n', 'k', 'paid', 'hit_tile', 'loss']);

export const updateSession = (id: string, fields: Record<string, unknown>, fromStatus?: string | string[]) =>
  updateRow('sessions', SESSION_COLUMNS, id, fields, fromStatus);
export const updateRound = (id: string, fields: Record<string, unknown>, fromStatus?: string | string[]) =>
  updateRow('session_rounds', ROUND_COLUMNS, id, fields, fromStatus);

export async function getSession(id: string): Promise<SessionRow | null> {
  const r = await pool.query<SessionRow>('select * from sessions where id = $1', [id]);
  return r.rows[0] ?? null;
}
