# Week 4 — Fiber lab (testnet)

Two local Fiber nodes (`fnn` v0.9.1) on CKB testnet, used for the week 4 report. Everything here follows [fiber.world/docs](https://www.fiber.world/docs).

```
project/
├── node1/config.yml   RPC 127.0.0.1:8227, P2P 8228 (the unchanged release testnet config)
├── node2/config.yml   RPC 127.0.0.1:8237, P2P 8238 (only the two listening ports changed)
├── logs/              real command output of every step, in order (00 … 26)
└── scripts/
    ├── balance.sh          on-chain balance of a lock_arg via the testnet indexer
    ├── relay_channels.py   lists the bottle/bracer channels in a node's gossip graph
    └── render_log.py       turns logs/*.txt into the HTML that the terminal screenshots were taken from
```

Not committed (see `.gitignore`): the `fnn` / `fnn-cli` / `ckb-cli` binaries, `node*/ckb/key`, `node*/fiber/` (channel store, backups) and `*.log`. The keys are throwaway testnet keys.

## Reproduce

```bash
# 1. binaries: fnn_v0.9.1-aarch64-darwin-portable.tar.gz from github.com/nervosnetwork/fiber/releases/tag/v0.9.1
#    and ckb-cli v1.12.0 from github.com/nervosnetwork/ckb-cli/releases; copy fnn + fnn-cli into node1/ and node2/
xattr -d com.apple.quarantine fnn fnn-cli            # macOS only

# 2. a throwaway key per node (64 hex chars, no 0x), then print its testnet address and fund it from faucet.nervos.org
mkdir -p node1/ckb && (umask 077; openssl rand -hex 32 > node1/ckb/key)
ckb-cli util key-info --privkey-path node1/ckb/key

# 3. start (fnn encrypts ckb/key on first start; keep the password)
cd node1 && FIBER_SECRET_KEY_PASSWORD='…' RUST_LOG=info ./fnn -c config.yml -d .
cd node2 && FIBER_SECRET_KEY_PASSWORD='…' RUST_LOG=info ./fnn -c config.yml -d .

# 4. talk to them
export NO_PROXY=127.0.0.1,localhost
./fnn-cli info
./fnn-cli --url http://127.0.0.1:8237 info
```
