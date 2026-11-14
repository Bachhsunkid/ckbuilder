-- CKB Mines game server schema. Idempotent: applied at every start.
create table if not exists bets (
  id uuid primary key,
  -- sealed -> committed -> opening -> open -> settling | losing | forfeiting -> won | lost | exited | forfeited
  -- or expired / failed
  status text not null,
  m int not null,
  stake bigint not null,               -- shannons
  player_lock jsonb not null,
  player_lock_hash text not null,
  seed_s text not null,                -- operator seed: secret until the bet is settled
  root_r text not null,
  seed_c text,
  root_q text,
  d_exit bigint not null,
  d_forfeit bigint not null,
  args jsonb,                          -- BetArgsJson once committed
  house_in text,                       -- house cell reserved for the bet tx
  bet_tx text,
  capacity bigint,
  opened_at timestamptz,               -- bet tx committed (block time)
  settle_tx text,
  settle_path text,                    -- A | B | C | D
  settle_house_in text,
  payout bigint,
  hit_tile int,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bets_status on bets (status);
-- unsigned cash-out the server built, compared with what the player signs
alter table bets add column if not exists settle_draft jsonb;

create table if not exists reveals (
  bet_id uuid not null references bets (id),
  tile int not null,
  position int not null,
  safe boolean not null,
  pick_secret text not null,
  created_at timestamptz not null default now(),
  primary key (bet_id, tile)
);

-- A house cell is spent by at most one transaction we build. Rows are kept after the
-- spend so a lagging indexer cannot hand the same cell out twice; old rows are pruned.
create table if not exists house_reservations (
  out_point text primary key,
  bet_id uuid,
  purpose text not null,
  created_at timestamptz not null default now(),
  released boolean not null default false
);

-- Sessions (ADR 0001): one deposit, many off-chain rounds.
create table if not exists sessions (
  id uuid primary key,
  -- committed -> opening -> open -> withdrawing | closing -> closed, or expired / failed
  status text not null,
  player_lock jsonb not null,
  player_lock_hash text not null,
  args jsonb not null,                 -- SessionArgsJson
  deposit bigint not null,             -- shannons
  house_deposit bigint not null,
  house_in text,                       -- house cell reserved for the deposit tx
  deposit_tx text,
  cell text,                           -- current session cell out point
  cell_at timestamptz,                 -- block time of the tx that created `cell`
  state jsonb not null,                -- newest state both signed: { state, sigP, sigH }
  pending jsonb,                       -- { n, state, sigH }: signed by us, waiting for the player
  chain_tx text,                       -- our last session transition, until it lands
  close_tx text,                       -- the transaction that paid the session out
  paid_player bigint,
  last_activity timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sessions_status on sessions (status);

create table if not exists session_rounds (
  id uuid primary key,
  session_id uuid not null references sessions (id),
  status text not null,                -- sealed -> live -> won | lost, or abandoned
  m int not null,
  stake bigint not null,
  seed_s text not null,
  root_r text not null,
  seed_c text,
  root_q text,
  n bigint,                            -- nonce of the state that opened the round
  k int,
  paid bigint,
  hit_tile int,
  loss jsonb,                          -- { t, p, proof }: the loss proof
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists session_rounds_session on session_rounds (session_id);

create table if not exists session_reveals (
  round_id uuid not null references session_rounds (id),
  tile int not null,
  position int not null,
  safe boolean not null,
  pick_secret text not null,
  created_at timestamptz not null default now(),
  primary key (round_id, tile)
);
