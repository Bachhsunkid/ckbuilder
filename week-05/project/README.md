# Week 5 — time-hash-lock (TypeScript lock script on ckb-js-vm)

A lock script written in TypeScript and run by [ckb-js-vm](https://github.com/nervosnetwork/ckb-js-vm). A cell locked with it can be spent only when

1. `witness.lock` is the passphrase whose CKB-blake2b hash is in the script args, and
2. every input of the script group carries a `since` that reaches the minimum in the script args, in the same metric.

Script args (after the 35 bytes ckb-js-vm keeps for its loader): `blake2b(passphrase)` (32 bytes) + minimum `since` (8 bytes, little-endian).

| Exit code | Meaning |
|---|---|
| 0 | unlocked |
| 1 | args have the wrong length |
| 2 | no witness / empty `lock` field |
| 3 | passphrase hash mismatch |
| 4 | `since` below the minimum |
| 5 | `since` uses another metric than the minimum (added in v2, the Type ID upgrade) |

This is a learning exercise, not a vault. The passphrase is public once the transaction is broadcast and the script does not constrain the outputs.

```
project/
├── contracts/time-hash-lock/src/index.ts   the script
├── tests/
│   ├── time-hash-lock.mock.test.ts         7 offline tests (ckb-testtool): 1 unlock, 6 expected failures
│   ├── time-hash-lock.testnet.test.ts      lock, 3 rejected unlocks, 1 real unlock on testnet (spends testnet CKB)
│   └── probe.testnet.test.ts               probe used for the Type ID upgrade demo
├── deployment/                             scripts.json + deployment records of the testnet deploy
└── ../logs, ../assets                      raw command output and screenshots used by the report
```

Not committed (`.gitignore`): `node_modules/`, `dist/`, `.env` (testnet private key), `txs/`.

## Run

```bash
npm install
npm test                                    # build + the offline tests

# replay one of the offline transactions in ckb-debugger
DUMP_DIR=txs npx jest tests/time-hash-lock.mock --maxWorkers=1
ckb-debugger --tx-file txs/unlock-ok.json --cell-index 0 --cell-type input --script-group-type lock

# testnet: put a funded testnet key in .env (PRIVATE_KEY=0x...), then
offckb deploy --network testnet --target dist --output deployment --type-id --privkey-file <file> --yes
RUN_TESTNET=1 npx jest tests/time-hash-lock.testnet --maxWorkers=1
```

`--maxWorkers=1` matters: ckb-testtool feeds ckb-debugger through stdin and parallel workers can deadlock.
