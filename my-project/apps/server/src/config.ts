import { config as loadEnv } from 'dotenv';
import path from 'path';
import { P } from '@ckb-mines/chain';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('PRIVATE_KEY missing in my-project/.env');

export const config = {
  port: num('PORT', 8787),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://mines:mines@127.0.0.1:5433/mines',
  privateKey,
  rpcUrl: process.env.CKB_RPC_URL || undefined,
  /** SPEC 4.6. Shorter values are used for the E2E runs. */
  tPlaySeconds: num('T_PLAY', 600),
  dExitSeconds: BigInt(num('D_EXIT', 900)),
  dForfeitSeconds: BigInt(num('D_FORFEIT', 86_400)),
  maxCollateral: BigInt(num('MAX_COLLATERAL_CKB', 2500)) * P.SHANNONS_PER_CKB,
  minStake: BigInt(num('MIN_STAKE_CKB', 10)) * P.SHANNONS_PER_CKB,
  /** a bet that is committed but never opened releases its house cell after this */
  commitTimeoutSeconds: num('COMMIT_TIMEOUT', 300),
  watchIntervalMs: num('WATCH_INTERVAL_MS', 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  /** ADR 0001: challenge window of a unilateral session close. 24 h in production, short for testnet runs. */
  dChallengeSeconds: BigInt(num('D_CHALLENGE', 86_400)),
  /** the operator closes a session after this long without a round */
  sessionIdleSeconds: num('SESSION_IDLE', 1800),
  minDeposit: BigInt(num('MIN_DEPOSIT_CKB', 100)) * P.SHANNONS_PER_CKB,
  maxDeposit: BigInt(num('MAX_DEPOSIT_CKB', 2000)) * P.SHANNONS_PER_CKB,
  maxSessionHouse: BigInt(num('MAX_SESSION_HOUSE_CKB', 2500)) * P.SHANNONS_PER_CKB,
  /** smallest stake of a session round; sessions have no per-bet cell, so this can be far below MIN_STAKE */
  sessionMinStake: BigInt(num('SESSION_MIN_STAKE_CKB', 1)) * P.SHANNONS_PER_CKB,
  /** set to 1 behind a reverse proxy (Railway, Fly, nginx) so rate limits see the client's IP */
  trustProxy: process.env.TRUST_PROXY === '1',
  /** requests per minute per IP, all routes; opening a session has its own lower limit */
  rateLimitPerMinute: num('RATE_LIMIT_PER_MIN', 600),
  sessionCreatesPerMinute: num('SESSION_CREATES_PER_MIN', 6),
  /**
   * Free hosts (Render) stop a service after 15 min without inbound traffic, which would also stop the
   * watchers. Pinging our own public URL keeps it awake. Render sets RENDER_EXTERNAL_URL itself.
   */
  keepAliveUrl: process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || undefined,
};

if (BigInt(config.tPlaySeconds) + 120n > config.dExitSeconds) {
  throw new Error('T_PLAY must end at least 2 minutes before D_EXIT so a late loss can still land (SPEC 4.6)');
}
if (config.dExitSeconds >= config.dForfeitSeconds) throw new Error('D_EXIT must be shorter than D_FORFEIT');
