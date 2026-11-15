import Fastify from 'fastify';
import cors from '@fastify/cors';
import { toJson } from '@ckb-mines/chain';
import { ApiError, Game } from './bets';
import { config } from './config';
import { HouseBusyError } from './house';
import { Sessions } from './sessions';

export async function buildApp(game: Game, sessions: Sessions) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 256 * 1024 });
  await app.register(cors, { origin: config.corsOrigin });

  // bigints and CCC objects serialize through ccc.stringify
  app.setReplySerializer((payload) => toJson(payload));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof HouseBusyError) return reply.status(503).send({ error: 'all house cells are busy, try again in a minute' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  type Id = { Params: { id: string } };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ ...game.publicConfig(), session: sessions.publicConfig() }));
  app.get('/api/house', async () => game.house.summary());
  app.get<{ Querystring: { player?: string } }>('/api/bets', async (req) => game.history(String(req.query.player ?? '')));
  app.post('/api/bets', async (req) => game.create((req.body ?? {}) as object));
  app.get<Id>('/api/bets/:id', async (req) => game.view(req.params.id));
  app.post<Id>('/api/bets/:id/commit', async (req) => game.commit(req.params.id, (req.body ?? {}) as object));
  app.post<Id>('/api/bets/:id/open', async (req) => game.open(req.params.id, (req.body ?? {}) as object));
  app.post<Id>('/api/bets/:id/reveal', async (req) => game.reveal(req.params.id, (req.body ?? {}) as object));
  app.post<Id>('/api/bets/:id/cashout', async (req) => game.cashOut(req.params.id, (req.body ?? {}) as object));
  app.post<Id>('/api/bets/:id/settle', async (req) => game.settle(req.params.id, (req.body ?? {}) as object));

  // sessions (ADR 0001)
  type Round = { Params: { id: string; round: string } };
  const body = (req: { body?: unknown }) => (req.body ?? {}) as object;
  app.post('/api/sessions', async (req) => sessions.create(body(req)));
  app.get<Id>('/api/sessions/:id', async (req) => sessions.view(req.params.id));
  app.post<Id>('/api/sessions/:id/open', async (req) => sessions.open(req.params.id, body(req)));
  app.post<Id>('/api/sessions/:id/rounds', async (req) => sessions.newRound(req.params.id, body(req)));
  app.post<Round>('/api/sessions/:id/rounds/:round/commit', async (req) => sessions.commitRound(req.params.id, req.params.round, body(req)));
  app.post<Round>('/api/sessions/:id/rounds/:round/reveal', async (req) => sessions.reveal(req.params.id, req.params.round, body(req)));
  app.post<Round>('/api/sessions/:id/rounds/:round/cashout', async (req) => sessions.cashOut(req.params.id, req.params.round, body(req)));
  app.post<Id>('/api/sessions/:id/ack', async (req) => sessions.ack(req.params.id, body(req)));
  app.post<Id>('/api/sessions/:id/withdraw', async (req) => sessions.withdraw(req.params.id, body(req)));
  return app;
}
