#!/bin/bash
# usage: bal.sh <lock_arg>  -> balance in CKB via testnet indexer
ARG=$1
curl -s -X POST -H 'Content-Type: application/json' https://testnet.ckbapp.dev/ -d '{"id":1,"jsonrpc":"2.0","method":"get_cells_capacity","params":[{"script":{"code_hash":"0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8","hash_type":"type","args":"'$ARG'"},"script_type":"lock"}]}' | python3 -I -c "
import json,sys
r=json.load(sys.stdin).get('result')
print(int(r['capacity'],16)/1e8 if r else 'n/a')"
