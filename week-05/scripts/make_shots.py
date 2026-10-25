"""Builds the terminal-style HTML pages that the week 5 screenshots were taken from.
Reads the raw command output in ../logs and keeps the lines that matter."""
import html, os, re, sys

LOGS = os.path.join(os.path.dirname(__file__), '..', 'logs')
ANSI = re.compile(r'\x1b\[[0-9;]*m')


def raw(name):
    return ANSI.sub('', open(os.path.join(LOGS, name)).read()).rstrip('\n').split('\n')


def pick(name, *needles):
    return [l.strip() for l in raw(name) if any(n in l for n in needles)]


def page(title, lines):
    body = []
    for l in lines:
        e = html.escape(l)
        if l.startswith('$ '):
            body.append(f'<span class="cmd">{e}</span>')
        elif '✓' in l or l.startswith('PASS') or '✅' in l:
            body.append(f'<span class="ok">{e}</span>')
        elif '✕' in l or 'rror' in l:
            body.append(f'<span class="err">{e}</span>')
        else:
            body.append(e)
    return f'''<!doctype html><meta charset=utf-8><title>{html.escape(title)}</title><style>
body{{margin:0;background:#1e1e1e;font:13px/1.5 Menlo,Monaco,monospace;color:#d4d4d4;width:1180px}}
.bar{{background:#323233;padding:8px 14px;color:#aaa;font-size:12px;display:flex;gap:8px;align-items:center}}
.dot{{width:11px;height:11px;border-radius:50%;display:inline-block}}
pre{{margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-all}}
.cmd{{color:#4ec9b0;font-weight:bold}} .ok{{color:#6a9955}} .err{{color:#f48771}}
</style><div class=bar><span class=dot style=background:#ff5f56></span><span class=dot style=background:#ffbd2e></span><span class=dot style=background:#27c93f></span><span style=margin-left:10px>{html.escape(title)}</span></div><pre>{chr(10).join(body)}</pre>'''


def main(out):
    os.makedirs(out, exist_ok=True)
    shots = {
        'a-mock-tests': ('time-hash-lock: mock tests (ckb-testtool)',
            ['$ npm run build', *pick('00-build.txt', 'Building contract', 'Bytecode', 'Successfully built'),
             '', '$ npx jest tests/time-hash-lock.mock --maxWorkers=1',
             *[l for l in raw('07-jest-mock-tests-v2.txt') if '✓' in l or '✕' in l or l.startswith('Tests:')]]),
        'b-debugger': ('ckb-debugger: replaying the dumped transactions',
            [*[l for l in raw('02-ckb-debugger.txt')], '', '# cycles of the unlock tx: bytecode (.bc) vs bundled JS (.js), and file sizes in bytes',
             *[l.strip() for l in raw('03-cycles-js-vs-bc.txt')], '', *raw('03b-sizes.txt')]),
        'c-deploy': ('offckb deploy --network testnet --type-id',
            ['$ offckb deploy --network testnet --target dist --output deployment --type-id --yes',
             *[l for l in raw('04-deploy-testnet-v1.txt') if 'deployed, tx hash' in l or 'committed' in l or 'Type ID' in l]]),
        'd-testnet': ('time-hash-lock on testnet: lock, reject, reject, reject, unlock',
            ['$ RUN_TESTNET=1 npx jest tests/time-hash-lock.testnet --maxWorkers=1',
             *[re.sub(r'\bat page https://\S+', '', l.strip()) for l in raw('05-testnet-demo.txt')
               if l.strip().startswith(('LOCK tx', 'WRONG', 'SINCE', 'TOO EARLY', 'UNLOCK tx')) or '✓' in l or l.startswith('Tests:')]]),
        'e-upgrade': ('Type ID upgrade: same lock script, new code',
            ['# cell locked before the upgrade, unlocked with a since of the wrong metric',
             '$ LOCK_TX=0x20c32d54… npx jest tests/probe.testnet     # v1 deployed',
             *[re.sub(r'\bpage https://\S+', '', l.strip()) for l in raw('06-probe-before-upgrade.txt') if 'PROBE' in l],
             '', '$ offckb deploy --network testnet --target dist --output deployment --type-id --yes     # v2',
             *[l.strip() for l in raw('08-deploy-testnet-v2-upgrade.txt') if 'Type ID' in l or 'Upgrade keeps' in l or 'tx hash' in l or 'committed' in l],
             '', '$ LOCK_TX=0x20c32d54… npx jest tests/probe.testnet     # v2 deployed',
             *[re.sub(r'\bpage https://\S+', '', l.strip()) for l in raw('09-probe-after-upgrade.txt') if 'PROBE' in l]]),
    }
    for k, (t, lines) in shots.items():
        open(os.path.join(out, k + '.html'), 'w').write(page(t, lines))
    print(list(shots))


if __name__ == '__main__':
    main(sys.argv[1])
