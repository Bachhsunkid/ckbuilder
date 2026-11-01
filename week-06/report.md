# Week 6 — week ending 2026-11-01

**Name:** Trinh Bach · **Track:** CKBuilders
**Focus:** Review Fiber and lock-script security; learn Molecule and reusable ecosystem scripts
**Time spent:** ~9h

## 1. Covered this week

| Item | Status |
|---|---|
| [Fiber: channels, invoices, routing](https://www.fiber.world/docs) | Review done |
| Fiber experiment: one-way channel payment failure | Replayed from Week 4 evidence |
| Week 5 `time-hash-lock` weakness review | Fixed and tested |
| [Serialization (Molecule)](https://docs.nervos.org/docs/serialization/serialization-molecule-in-ckb) | First read |
| [Ecosystem Scripts](https://docs.nervos.org/docs/ecosystem-scripts/introduction) | First read |

## 2. Key learnings

**Fiber review**

- `ChannelReady` only says the channel is usable as a channel; it does not guarantee a payment route with enough outbound liquidity. The Week 4 one-way-channel experiment made this concrete: the reverse direction failed with `Failed to build route`.
- A Fiber payment is an off-chain state transition protected by TLCs. The preimage settles the receiver side, while the timelock gives the sender a failure path if the route does not settle.

**Molecule and ecosystem scripts**

- Molecule is the binary schema/serialization layer used for CKB structures. A table has fixed offsets and a vector has a length plus elements, so parsers can validate boundaries before interpreting fields.
- Ecosystem scripts are reusable protocol components, not just sample contracts. Reusing a tested lock/type script means the application mainly composes cell deps, scripts, args, and witnesses instead of reimplementing validation.

**Lock review**

- The original lock verified the passphrase and `since` but let the transaction send the cell to any output lock. I changed the args to commit to a recipient lock hash and made the script reject every output whose lock hash differs.
- This fixes recipient substitution, but it does not make the exercise a vault: the passphrase remains visible in the witness and the design still needs a more complete transaction policy for production use.

## 3. Practical progress

- **Fiber review experiment.** Rechecked the Week 4 one-way-channel logs and confirmed that a channel can be ready while reverse payment routing still fails. Evidence: [`week-04/project/logs/24-oneway-payments.txt`](../week-04/project/logs/24-oneway-payments.txt) and the original screenshots in [`week-04/assets/`](../week-04/assets/).

- **Fixed the Week 5 output-substitution weakness.** `time-hash-lock` now reads output lock hashes and compares them with the 32-byte recipient hash committed in args. The mock suite adds an attacker-recipient case and expects exit code `6`: [`week-05/project/contracts/time-hash-lock/src/index.ts`](../week-05/project/contracts/time-hash-lock/src/index.ts), [`week-05/project/tests/time-hash-lock.mock.test.ts`](../week-05/project/tests/time-hash-lock.mock.test.ts).

  ```text
  PASS tests/time-hash-lock.mock.test.ts
  Tests: 8 passed, 6 skipped
  Script log: output lock hash does not match the committed recipient
  Run result: 6
  ```

## 4. Blockers / questions


