#!/usr/bin/env python3
"""Install own files and one hash-checked early loader block. Preview by default."""
import argparse, hashlib, json, os, pathlib, shutil, stat, sys, tempfile

BEGIN=b'\n<!-- TAVERNFLOW BOOT BEGIN -->\n'
END=b'<!-- TAVERNFLOW BOOT END -->\n'
MARKER='.tavern-flow-install.json'
BOOT_RECEIPT='.tavern-flow-boot.json'
LEGACY_READ_HOOKS={
 'public/script.js':[(b"const response = await fetch('/api/chats/get', {", b"const response = await (globalThis.__tavernFlowBoot?.nativeRead || fetch)('/api/chats/get', { /* TAVERNFLOW NATIVE READ */")],
 'public/scripts/group-chats.js':[
  (b'async function loadGroupChat(chatId) {',b'async function loadGroupChat(chatId, nativeNavigation = false) { /* TAVERNFLOW NATIVE READ */'),
  (b"const response = await fetch('/api/chats/group/get', {",b"const response = await (nativeNavigation && globalThis.__tavernFlowBoot?.nativeRead || fetch)('/api/chats/group/get', { /* TAVERNFLOW NATIVE READ */"),
  (b'const data = await loadGroupChat(chat_id);',b'const data = await loadGroupChat(chat_id, true); /* TAVERNFLOW NATIVE READ */'),
 ],
}
READ_HOOKS_041={
 'public/script.js':[
  *LEGACY_READ_HOOKS['public/script.js'],
  (b'const data = await response.json();\n        if (Array.isArray(data) && data.length > 0) {',
   b'const data = await response.json();\n        globalThis.__tavernFlowBoot?.adoptRead?.(response, data); /* TAVERNFLOW NATIVE READ */\n        if (Array.isArray(data) && data.length > 0) {'),
  (b"export async function getSettings(initLoaderHandle = null) {\n    const response = await fetch('/api/settings/get', {",
   b"export async function getSettings(initLoaderHandle = null) {\n    const response = await (globalThis.__tavernFlowBoot?.nativeRead || fetch)('/api/settings/get', { /* TAVERNFLOW NATIVE READ */"),
  (b'settings = JSON.parse(data.settings);',
   b'settings = JSON.parse(data.settings);\n        globalThis.__tavernFlowBoot?.adoptRead?.(response, data.settings); /* TAVERNFLOW NATIVE READ */'),
 ],
 'public/scripts/group-chats.js':[
  *LEGACY_READ_HOOKS['public/scripts/group-chats.js'],
  (b'if (!Array.isArray(data)) {\n            return [];\n        }\n        return data;',
   b'if (!Array.isArray(data)) {\n            return [];\n        }\n        if (nativeNavigation) globalThis.__tavernFlowBoot?.adoptRead?.(response, data); /* TAVERNFLOW NATIVE READ */\n        return data;'),
 ],
 'public/scripts/extensions/quick-reply/index.js':[
  (b"const response = await fetch('/api/settings/get', {",
   b"const response = await (globalThis.__tavernFlowBoot?.quickReplyRead || fetch)('/api/settings/get', { /* TAVERNFLOW NATIVE READ */"),
 ],
}
# Each supported release has a fixed uninstall receipt, even when a later
# release adds native hooks.
HOOKS = {path: list(pairs) for path, pairs in READ_HOOKS_041.items()}

# Reuse the validated inner settings only on the host call site that consumes
# it. Other readers (or a wrapper that replaced the string) keep JSON.parse.
settings_old, settings_041 = HOOKS['public/script.js'][-1]
HOOKS['public/script.js'][-1] = (settings_old, settings_041.replace(
 b'settings = JSON.parse(data.settings);',
 b'settings = globalThis.__tavernFlowBoot?.parseNativeSettings ? globalThis.__tavernFlowBoot.parseNativeSettings(response, data.settings) : JSON.parse(data.settings);',
))
# The serializer still takes a synchronous, consistent JSON snapshot. The
# current fetch chain sees that same body; a ready worker handles compression.
for relative, variable, endpoint, next_line in [
 ('public/script.js', 'saveSettingsRequest', '/api/settings/save', "            method: 'POST',"),
 ('public/script.js', 'saveChatRequest', '/api/chats/save', "            method: 'POST',"),
 ('public/scripts/group-chats.js', 'saveGroupChatRequest', '/api/chats/group/save', "        method: 'POST',"),
]:
 prefix = f'const {variable} = await '
 anchor = (prefix + 'compressRequest({\n' + next_line).encode()
 replacement = (prefix + f"(globalThis.__tavernFlowBoot?.nativeSavePreparer?.('{endpoint}', compressRequest) ?? compressRequest)({{\n" + next_line).encode()
 HOOKS[relative].append((anchor, replacement))

# A UTF-8 string takes between one and three bytes per UTF-16 code unit.
# If even these bounds are outside the configured gzip window, native code
# would return the same request; no need to allocate an encoded copy.
HOOKS['public/scripts/request-compression.js'] = [(
 b'    const textEncoder = new TextEncoder();',
 b'    if (globalThis.__tavernFlowBoot?.outsideCompressionWindow?.(requestBody.length, requestCompressionConfig)) return plainRequest; /* TAVERNFLOW SAVE */\n    const textEncoder = new TextEncoder();',
)]

def hooks_for_version(version):
 sets = {'0.4.0': LEGACY_READ_HOOKS, '0.4.1': READ_HOOKS_041, '0.5.0': HOOKS}
 if version not in sets:
  raise SystemExit('不认识该版本的安装回执，拒绝自动回滚')
 return sets[version]

VERIFIED={
 'public/scripts/request-compression.js':'0222d3418ab2ac604f7170d924575bc1419c31259c028cf4164c0dc566c4c50f',
 'public/script.js':'955c603d0bad84bac5a716f0818d85c2543e44d4c43878e0d63ef1e55ca91855',
 'public/scripts/events.js':'2aa1c20f140fab8967e6f850bd6e253bd0aa6e7c6a2e0540778cb11dd0f3a6ea',
 'public/scripts/group-chats.js':'862eb24dfe1f596a2bd6d039a69397667829e0fc34471d22d2028d7781a5c73c',
 'public/scripts/extensions/quick-reply/index.js':'d486692119260c299545f8b1a0390dedc003888c5508e2b4b59abb131c0b4911',
 'src/endpoints/settings.js':'bbc3d36ad758b1fc567f63f1e24eada063172791005c5b3baadc195b78726955',
 'src/endpoints/chats.js':'40012ebc71a75357e62f7532e5b20def0d8b6c132bb6ab48f662993cc97b9063',
}
def sha(data): return hashlib.sha256(data).hexdigest()
def inventory(dest):
 return {str(f.relative_to(dest)):sha(f.read_bytes()) for f in dest.rglob('*') if f.is_file() and f.name!=MARKER}
def hook_receipt(hooks):
 return {relative:[sha(new) for _,new in pairs] for relative,pairs in hooks.items()}
def atomic_write(file,data):
 original=file.lstat()
 if not stat.S_ISREG(original.st_mode):raise OSError('不是普通文件：'+str(file))
 fd,name=tempfile.mkstemp(prefix='.tavern-flow-',dir=file.parent)
 try:
  with os.fdopen(fd,'wb') as stream:
   stream.write(data);stream.flush()
   current=os.fstat(stream.fileno())
   if (current.st_uid,current.st_gid)!=(original.st_uid,original.st_gid):
    os.fchown(stream.fileno(),original.st_uid,original.st_gid)
   os.fchmod(stream.fileno(),stat.S_IMODE(original.st_mode))
   os.fsync(stream.fileno())
  os.replace(name,file)
 finally:
  if os.path.exists(name):os.unlink(name)
def remove_boot(index,receipt):
 if index.count(BEGIN)!=1 or index.count(END)!=1:raise SystemExit('启动块缺失或重复，拒绝修改index.html')
 start=index.index(BEGIN);finish=index.index(END,start)+len(END);block=index[start:finish]
 if sha(block)!=receipt.get('blockSha256'):raise SystemExit('启动块已有变化，拒绝删除')
 return index[:start]+index[finish:]
def recovery_snapshot(staging,changes):
 # Keep original bytes independently of atomic_write: compensation can fail too.
 records=[]
 for i,(file,data,_) in enumerate(changes):
  backup=pathlib.Path(staging)/('host-before-'+str(i))
  original=file.lstat()
  backup.write_bytes(data)
  records.append({'target':str(file),'backup':str(backup),'sha256':sha(data),
                  'uid':original.st_uid,'gid':original.st_gid,'mode':stat.S_IMODE(original.st_mode)})
 (pathlib.Path(staging)/'recovery.json').write_text(json.dumps(records,indent=2))
def restore_written(written):
 failures=[]
 for file,data in reversed(written):
  try:atomic_write(file,data)
  except BaseException as error:failures.append(str(file)+': '+str(error))
 return failures
def finish_failed_recovery(staging,failures):
 if failures:
  print('自动补偿未全部完成；已保留原始文件和恢复清单：'+str(staging)+'\n'+'\n'.join(failures),file=sys.stderr)
 else:shutil.rmtree(staging)
def main():
 p=argparse.ArgumentParser(description='清酌安装器：默认预览。安装后重启酒馆、刷新页面。')
 p.add_argument('--host',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--rollback',action='store_true');a=p.parse_args()
 host=pathlib.Path(a.host).resolve();package=json.loads((host/'package.json').read_text())
 if package.get('name')!='sillytavern':raise SystemExit('目标不是SillyTavern')
 if not a.rollback and package.get('version')!='1.19.0':raise SystemExit('仅支持已核验的SillyTavern 1.19.0')
 base=pathlib.Path(__file__).resolve().parents[1];source_layout=(base/'client').exists()
 front=base/('client' if source_layout else 'extension');back=base if source_layout else base/'server-plugin'
 targets=[host/'public/scripts/extensions/third-party/tavern-flow',host/'plugins/tavern-flow']
 index_file=host/'public/index.html';before=index_file.read_bytes();after=before
 changes=[]
 if a.rollback:
  for dest in targets:
   if not dest.exists():continue
   receipt=dest/MARKER
   if not receipt.exists() or inventory(dest)!=json.loads(receipt.read_text()):raise SystemExit('安装文件缺标记或已有变化，拒绝自动回滚：'+str(dest))
  boot=targets[0]/BOOT_RECEIPT
  if boot.exists():
   boot_data=json.loads(boot.read_text());after=remove_boot(before,boot_data)
   hooks=hooks_for_version(boot_data.get('version'))
   if boot_data.get('nativeHooks')!=hook_receipt(hooks):raise SystemExit('原生读取标记回执不匹配')
   for relative,pairs in hooks.items():
    file=host/relative;data=file.read_bytes();result=data
    for old,new in reversed(pairs):
     if result.count(new)!=1:raise SystemExit('原生读取标记缺失或已有变化，拒绝回滚：'+relative)
     result=result.replace(new,old,1)
    changes.append((file,data,result))
  elif BEGIN in before or END in before:raise SystemExit('启动块缺少安装回执，拒绝修改')
  if after!=before:changes.append((index_file,before,after))
  print(json.dumps({'rollback':[str(x) for x in targets],'changesIndex':after!=before,'nativeReadHooks':len(changes)-(after!=before),'apply':a.apply}))
  if not a.apply:return
  # Preserve later user edits outside our block. All preflight checks precede mutations.
  if any(file.read_bytes()!=data for file,data,_ in changes):raise SystemExit('预览后宿主发生变化，拒绝修改')
  staging=tempfile.mkdtemp(prefix='.tavern-flow-uninstall-',dir=host)
  moved=[];written=[]
  try:
    recovery_snapshot(staging,changes)
    for i,dest in enumerate(targets):
     if dest.exists():backup=pathlib.Path(staging)/str(i);shutil.move(dest,backup);moved.append((dest,backup))
    for file,data,result in changes:atomic_write(file,result);written.append((file,data))
  except BaseException:
    failures=restore_written(written)
    for dest,backup in reversed(moved):
     try:shutil.move(backup,dest)
     except BaseException as error:failures.append(str(dest)+': '+str(error))
    finish_failed_recovery(staging,failures)
    raise
  shutil.rmtree(staging)
  return
 if any(dest.exists() for dest in targets):raise SystemExit('清酌目录已存在；请先核验并回滚旧版本，拒绝覆盖')
 if BEGIN in before or END in before:raise SystemExit('已有启动块，拒绝重复安装')
 for relative,digest in VERIFIED.items():
  if sha((host/relative).read_bytes())!=digest:raise SystemExit('宿主源码未核验，拒绝注入启动块：'+relative)
 for relative,pairs in HOOKS.items():
  file=host/relative;data=file.read_bytes();result=data
  if b'TAVERNFLOW NATIVE READ' in data:raise SystemExit('已有原生读取标记：'+relative)
  for old,new in pairs:
   if result.count(old)!=1:raise SystemExit('无法唯一定位原生读取入口：'+relative)
   result=result.replace(old,new,1)
  changes.append((file,data,result))
 if before.count(b'</head>')!=1:raise SystemExit('无法唯一定位head，拒绝修改index')
 code=(front/'boot.js').read_bytes().replace(b'</script',b'<\\/script')
 block=BEGIN+b'<script id="tavern-flow-boot">\n'+code+b'\n</script>\n'+END
 after=before.replace(b'</head>',block+b'</head>',1)
 changes.append((index_file,before,after))
 print(json.dumps({'install':[str(x) for x in targets],'changesIndex':True,'nativeReadHooks':list(HOOKS),'apply':a.apply}))
 if not a.apply:return
 staging=tempfile.mkdtemp(prefix='.tavern-flow-install-',dir=host)
 stage=[pathlib.Path(staging)/'front',pathlib.Path(staging)/'back'];installed=[];written=[]
 try:
   recovery_snapshot(staging,changes)
   shutil.copytree(front,stage[0]);(stage[0]/'lib').mkdir(exist_ok=True);shutil.copy2(back/'shared/protocol.mjs',stage[0]/'lib/protocol.mjs')
   stage[1].mkdir()
   for d in ['server','shared']:shutil.copytree(back/d,stage[1]/d)
   version=json.loads((front/'manifest.json').read_text())['version']
   (stage[1]/'package.json').write_text(json.dumps({'name':'tavern-flow','version':version,'type':'module','main':'server/index.mjs','license':'AGPL-3.0-only'}))
   (stage[0]/BOOT_RECEIPT).write_text(json.dumps({'blockSha256':sha(block),'beforeSha256':sha(before),'version':version,'nativeHooks':hook_receipt(HOOKS)}))
   for dest in stage:
    for notice in ['LICENSE','NOTICE.md']:shutil.copy2(base/notice,dest/notice)
    (dest/MARKER).write_text(json.dumps(inventory(dest),indent=2))
   if any(file.read_bytes()!=data for file,data,_ in changes) or any(dest.exists() for dest in targets):raise SystemExit('宿主已变化，拒绝安装')
   for source,dest in zip(stage,targets):dest.parent.mkdir(parents=True,exist_ok=True);shutil.move(source,dest);installed.append(dest)
   for file,data,result in changes:atomic_write(file,result);written.append((file,data))
 except BaseException:
   failures=restore_written(written)
   if not failures:
    for dest in reversed(installed):
     try:shutil.rmtree(dest)
     except BaseException as error:failures.append(str(dest)+': '+str(error))
   finish_failed_recovery(staging,failures)
   raise
 shutil.rmtree(staging)
 print('清酌文件、早期加载块及原生读取入口已安装；需重启酒馆、关闭旧页后重开。未修改用户设置。')
if __name__=='__main__':main()
