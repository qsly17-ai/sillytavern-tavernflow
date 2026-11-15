#!/usr/bin/env python3
"""Install only TavernFlow's own files; no settings or other plugin changes."""
import argparse, hashlib, json, pathlib, shutil, time
p=argparse.ArgumentParser(description='清酌安装器：默认只查看计划。安装后需重启酒馆并在界面停用重叠优化、刷新。')
p.add_argument('--host',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--rollback',action='store_true');a=p.parse_args()
host=pathlib.Path(a.host).resolve(); package=json.loads((host/'package.json').read_text())
if package.get('name')!='sillytavern' or package.get('version')!='1.19.0': raise SystemExit('仅支持已核验的SillyTavern 1.19.0')
base=pathlib.Path(__file__).resolve().parents[1]
source_layout=(base/'client').exists()
front=base/('client' if source_layout else 'extension')
back=base if source_layout else base/'server-plugin'
targets=[host/'public/scripts/extensions/third-party/tavern-flow',host/'plugins/tavern-flow']
marker='.tavern-flow-install.json'
if a.rollback:
    for dest in targets:
        if not dest.exists(): continue
        receipt=dest/marker
        if not receipt.exists(): raise SystemExit('目标缺少本安装器标记，拒绝删除：'+str(dest))
        recorded=json.loads(receipt.read_text())
        current={str(f.relative_to(dest)):hashlib.sha256(f.read_bytes()).hexdigest() for f in dest.rglob('*') if f.is_file() and f.name!=marker}
        if current!=recorded: raise SystemExit('安装文件已有变化，拒绝自动回滚：'+str(dest))
    print(json.dumps({'rollback':[str(x) for x in targets],'apply':a.apply}))
    if a.apply:
        for dest in targets:
            if dest.exists(): shutil.rmtree(dest)
else:
    if any(dest.exists() for dest in targets): raise SystemExit('清酌目录已存在；请先核验并回滚旧版本，拒绝覆盖')
    print(json.dumps({'install':[str(x) for x in targets],'apply':a.apply,'changesOtherPlugins':False}))
    if a.apply:
        shutil.copytree(front,targets[0]);(targets[0]/'lib').mkdir(exist_ok=True)
        shutil.copy2(back/'shared/protocol.mjs',targets[0]/'lib/protocol.mjs')
        targets[1].mkdir(parents=True)
        for d in ['server','shared']: shutil.copytree(back/d,targets[1]/d)
        (targets[1]/'package.json').write_text(json.dumps({'name':'tavern-flow','version':'0.3.0','type':'module','main':'server/index.mjs','license':'AGPL-3.0-only'}))
        for dest in targets:
            for notice in ['LICENSE','NOTICE.md']: shutil.copy2(base/notice,dest/notice)
            receipt={str(f.relative_to(dest)):hashlib.sha256(f.read_bytes()).hexdigest() for f in dest.rglob('*') if f.is_file()}
            (dest/marker).write_text(json.dumps(receipt,indent=2))
        print('文件安装完成；须重启酒馆加载后端，并刷新页面。安装器未修改其他插件或设置。')
