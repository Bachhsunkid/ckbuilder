import json,sys,urllib.request
port=sys.argv[1]
def rpc(m,p):
    r=urllib.request.Request(f'http://127.0.0.1:{port}',json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),{'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(r))['result']
B='02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71'; R='0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc'
chs=[];after=None
while True:
    p={"limit":"0x1f4"}
    if after: p["after"]=after
    r=rpc('graph_channels',[p]); chs+=r['channels']; after=r.get('last_cursor')
    if len(r['channels'])<500: break
nodes=rpc('graph_nodes',[{"limit":"0x1f4"}])['nodes']
print('nodes',len(nodes),'channels',len(chs))
for c in chs:
    n1,n2=c['node1'],c['node2']
    if B in (n1,n2) or R in (n1,n2): print(('B' if B in (n1,n2) else ' ')+('R' if R in (n1,n2) else ' '), n1[:8],n2[:8], int(c['capacity'],16)/1e8, c['channel_outpoint'][:20])
