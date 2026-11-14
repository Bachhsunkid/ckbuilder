import { ccc } from '@ckb-ccc/core';
import { freeCells, lockHash, outPointKey, type CellRef } from '@ckb-mines/chain';
import { config } from './config';
import { pool } from './db';

/** The operator wallet. Its plain cells are the pool shards (SPEC 7.2): any free one can back a bet. */
export class House {
  private constructor(
    readonly client: ccc.Client,
    readonly signer: ccc.SignerCkbPrivateKey,
    readonly lock: ccc.Script,
  ) {}

  static async create(): Promise<House> {
    const client = new ccc.ClientPublicTestnet(config.rpcUrl ? { url: config.rpcUrl } : undefined);
    const signer = new ccc.SignerCkbPrivateKey(client, config.privateKey);
    const lock = (await signer.getRecommendedAddressObj()).script;
    return new House(client, signer, lock);
  }

  get lockHash(): Uint8Array {
    return lockHash(this.lock);
  }

  /** Reserves the smallest free house cell with at least `need` shannons. */
  async reserve(need: bigint, betId: string, purpose: string): Promise<CellRef> {
    const cells = (await freeCells(this.client, this.lock, 200)).filter((c) => c.capacity >= need).reverse();
    for (const c of cells) {
      const key = outPointKey(c.outPoint);
      const r = await pool.query(
        'insert into house_reservations (out_point, bet_id, purpose) values ($1, $2, $3) on conflict do nothing',
        [key, betId, purpose],
      );
      if (r.rowCount === 0) continue;
      if (await this.client.getCellLive(c.outPoint, false)) return c;
      // Not live (yet): drop our row and look again next time. Cells our own pending
      // transactions spend keep the row they got when they were reserved.
      await this.release(key);
    }
    throw new HouseBusyError(`no free house cell with ${ccc.fixedPointToString(need)} CKB`);
  }

  /**
   * Reserves one cell with at least `need`, or else several free cells that add up to it
   * (largest first). Merging keeps the pool from fragmenting into cells too small to use.
   */
  async reserveMany(need: bigint, ownerId: string, purpose: string): Promise<CellRef[]> {
    try {
      return [await this.reserve(need, ownerId, purpose)];
    } catch (e) {
      if (!(e instanceof HouseBusyError)) throw e;
    }
    const picked: CellRef[] = [];
    let sum = 0n;
    for (const c of await freeCells(this.client, this.lock, 200)) {
      if (sum >= need) break;
      const key = outPointKey(c.outPoint);
      const r = await pool.query('insert into house_reservations (out_point, bet_id, purpose) values ($1, $2, $3) on conflict do nothing', [key, ownerId, purpose]);
      if (r.rowCount === 0) continue;
      if (!(await this.client.getCellLive(c.outPoint, false))) {
        await this.release(key);
        continue;
      }
      picked.push(c);
      sum += c.capacity;
    }
    if (sum < need) {
      for (const c of picked) await this.release(outPointKey(c.outPoint));
      throw new HouseBusyError(`free house cells hold less than ${ccc.fixedPointToString(need)} CKB`);
    }
    return picked;
  }

  /** Frees a reservation whose transaction was never broadcast. */
  async release(key: string | null | undefined) {
    if (key) await pool.query('delete from house_reservations where out_point = $1', [key]);
  }

  /** Adds the house witness placeholder and cell deps. Must happen before the other party signs. */
  async prepare(tx: ccc.Transaction): Promise<ccc.Transaction> {
    return this.signer.prepareTransaction(tx);
  }

  /** Signs a transaction the other party already signed; must not change its hash. */
  async cosign(tx: ccc.Transaction): Promise<ccc.Transaction> {
    return this.signer.signOnlyTransaction(tx);
  }

  /** Prepares and signs a transaction only the house signs. */
  async signAlone(tx: ccc.Transaction): Promise<ccc.Transaction> {
    return this.signer.signTransaction(tx);
  }

  async summary() {
    const cells = await freeCells(this.client, this.lock, 200);
    const reserved = new Set((await pool.query<{ out_point: string }>('select out_point from house_reservations')).rows.map((r) => r.out_point));
    const free = cells.filter((c) => !reserved.has(outPointKey(c.outPoint)));
    const total = cells.reduce((a, c) => a + c.capacity, 0n);
    return {
      address: await this.signer.getRecommendedAddress(),
      cells: cells.length,
      freeCells: free.length,
      balance: total,
      largestFree: free.reduce((a, c) => (c.capacity > a ? c.capacity : a), 0n),
    };
  }

  async pruneReservations() {
    await pool.query("delete from house_reservations where created_at < now() - interval '3 hours'");
  }
}

export class HouseBusyError extends Error {}
