// Public numbers for the Stats and Leaderboard tabs, read from the operator's database.
// Every figure is about settled session rounds; the chain holds the deposits and payouts behind them.
import { ccc } from '@ckb-ccc/core';
import { P } from '@ckb-mines/chain';
import { pool } from './db';
import { House } from './house';

const OPENED = "('opening', 'open', 'withdrawing', 'closing', 'closed')";
const SETTLED = "('won', 'lost')";
const CACHE_MS = 15_000;

/** Multiplier as a fixed-point number with 2 decimals, so it survives JSON. */
const mult100 = (k: number, m: number) => Math.round(P.multiplier(k, m) * 100);

export class Stats {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly house: House) {}

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  summary() {
    return this.cached('summary', async () => {
      const s = (
        await pool.query<{ opened: string; live: string; players: string }>(
          `select count(*) filter (where status in ${OPENED}) as opened,
                  count(*) filter (where status in ('opening', 'open', 'withdrawing', 'closing')) as live,
                  count(distinct player_lock_hash) filter (where status in ${OPENED}) as players
             from sessions`,
        )
      ).rows[0];
      const r = (
        await pool.query<{ rounds: string; won: string; volume: string | null; paid: string | null; biggest: string | null }>(
          `select count(*) as rounds, count(*) filter (where status = 'won') as won,
                  sum(stake) as volume, sum(coalesce(paid, 0)) as paid, max(paid) as biggest
             from session_rounds where status in ${SETTLED}`,
        )
      ).rows[0];
      const best = (
        await pool.query<{ m: number; k: number }>(`select m, k from session_rounds where status = 'won' and k > 0 group by m, k`)
      ).rows.reduce((a, x) => Math.max(a, mult100(x.k, x.m)), 0);
      const byDifficulty = (
        await pool.query<{ m: number; rounds: string; won: string }>(
          `select m, count(*) as rounds, count(*) filter (where status = 'won' and k > 0) as won from session_rounds where status in ${SETTLED} group by m order by m`,
        )
      ).rows.map((x) => ({ m: x.m, rounds: Number(x.rounds), won: Number(x.won) }));
      const paidOut = (await pool.query<{ total: string | null }>("select sum(paid_player) as total from sessions where status = 'closed'")).rows[0];
      const house = await this.house.summary();
      return {
        sessions: Number(s.opened),
        liveSessions: Number(s.live),
        players: Number(s.players),
        rounds: Number(r.rounds),
        roundsWon: Number(r.won),
        volume: r.volume ?? '0',
        paidInRounds: r.paid ?? '0',
        biggestWin: r.biggest ?? '0',
        bestMultiplier100: best,
        withdrawnOnChain: paidOut.total ?? '0',
        byDifficulty,
        houseBalance: house.balance.toString(),
        houseLargestFree: house.largestFree.toString(),
        houseFree: house.freeBalance.toString(),
      };
    });
  }

  leaderboard(period: string) {
    const days = period === 'week' ? 7 : period === 'day' ? 1 : null;
    const since = days ? `and r.updated_at > now() - interval '${days} days'` : '';
    return this.cached(`leaderboard:${days ?? 'all'}`, async () => {
      const rows = (
        await pool.query<{ player_lock_hash: string; player_lock: ccc.ScriptLike; rounds: string; wagered: string; net: string; biggest: string | null }>(
          `select s.player_lock_hash, (array_agg(s.player_lock))[1] as player_lock,
                  count(*) as rounds, sum(r.stake) as wagered,
                  sum(coalesce(r.paid, 0) - r.stake) as net, max(r.paid) as biggest
             from session_rounds r join sessions s on s.id = r.session_id
            where r.status in ${SETTLED} ${since}
            group by s.player_lock_hash
            order by net desc
            limit 50`,
        )
      ).rows;
      // best multiplier per player, computed from the rules rather than stored
      const best = new Map<string, number>();
      for (const x of (
        await pool.query<{ player_lock_hash: string; m: number; k: number }>(
          `select s.player_lock_hash, r.m, r.k from session_rounds r join sessions s on s.id = r.session_id
            where r.status = 'won' and r.k > 0 ${since} group by 1, 2, 3`,
        )
      ).rows) {
        best.set(x.player_lock_hash, Math.max(best.get(x.player_lock_hash) ?? 0, mult100(x.k, x.m)));
      }
      return {
        period: days ? period : 'all',
        players: rows.map((x) => ({
          address: ccc.Address.fromScript(ccc.Script.from(x.player_lock), this.house.client).toString(),
          rounds: Number(x.rounds),
          wagered: x.wagered,
          net: x.net,
          biggestWin: x.biggest ?? '0',
          bestMultiplier100: best.get(x.player_lock_hash) ?? 0,
        })),
      };
    });
  }
}
