import html,sys,os
def render(title, files, out):
    body=[]
    for f in files:
        for line in open(f).read().rstrip('\n').split('\n'):
            e=html.escape(line)
            if line.startswith('$ '): body.append(f'<span class="cmd">{e}</span>')
            elif line.startswith('#'): body.append(f'<span class="cm">{e}</span>')
            elif line.startswith('Error'): body.append(f'<span class="err">{e}</span>')
            else: body.append(e)
        body.append('')
    page=f'''<!doctype html><meta charset=utf-8><title>{html.escape(title)}</title><style>
body{{margin:0;background:#1e1e1e;font:13px/1.45 Menlo,Monaco,monospace;color:#d4d4d4;width:1180px}}
.bar{{background:#323233;padding:8px 14px;color:#aaa;font-size:12px;display:flex;gap:8px;align-items:center}}
.dot{{width:11px;height:11px;border-radius:50%;display:inline-block}}
pre{{margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-all}}
.cmd{{color:#4ec9b0;font-weight:bold}} .cm{{color:#7f8c8d}} .err{{color:#f48771}}
</style><div class=bar><span class=dot style=background:#ff5f56></span><span class=dot style=background:#ffbd2e></span><span class=dot style=background:#27c93f></span><span style=margin-left:10px>{html.escape(title)}</span></div><pre>{chr(10).join(body)}</pre>'''
    open(out,'w').write(page)
if __name__=='__main__':
    LOG='/Users/trinhbach/Workspace/working/ckb/ckbuilder/week-04/project/logs/'
    OUT=sys.argv[1]
    specs={
     'a-install-and-start':('fnn v0.9.1 — two local nodes',['00-install-and-start.txt']),
     'b-first-channel':('Basic transfer — connect, open channel, ChannelReady',['02-connect-open-channel.txt','03-channel-ready.txt']),
     'c-first-payment':('Basic transfer — invoice, payment, balances',['04-invoice.txt','05-send-payment.txt','06-balances-after-payment.txt']),
     'd-hold-settle':('Hold invoice — Received, wrong preimage, settle',['07-hold-invoice-create.txt','08-hold-invoice-received.txt','09-hold-invoice-settle.txt']),
     'e-hold-cancel':('Hold invoice — cancel returns the locked funds',['10-hold-invoice-cancel.txt']),
     'f-multihop-fail':('Multi-hop — public relays bottle / bracer',['12-connect-relays.txt','14-relay-channels-ready.txt','16-multihop-attempt-bottle-bracer.txt']),
     'g-multihop-ok':('Multi-hop — node1 -> bottle -> node2, then trampoline',['17-node2-bottle-channel.txt','18-multihop-success.txt','19-multihop-balances.txt','20-trampoline.txt']),
     'h-oneway':('Unidirectional channel',['22-oneway-open-explicit.txt','23-oneway-ready.txt','24-oneway-payments.txt']),
     'i-close-all':('Close every channel cooperatively',['25-close-all.txt','26-all-closed.txt']),
    }
    for k,(t,fs) in specs.items(): render(t,[LOG+f for f in fs],os.path.join(OUT,k+'.html'))
    print(list(specs))
