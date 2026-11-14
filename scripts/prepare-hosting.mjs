import {readdir,lstat,mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const target=await mkdtemp(join(root,'artifacts','sharing-hosting-'));
const inventory=[];
async function copy(relative,destination=relative) {
  const source=join(root,relative),stat=await lstat(source);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('NON_REGULAR_SOURCE');
  const bytes=await readFile(source);
  const path=join(target,destination);await mkdir(dirname(path),{recursive:true});
  await writeFile(path,bytes);
  inventory.push({path:destination,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
// Positive allowlist: never copy environment files, budgets, APKs, SDKs or test artifacts.
for(const directory of ['server','server/public','server/shared','server/routing','server/catalog']) {
  for(const name of (await readdir(join(root,directory))).sort()) {
    if(/^[a-z0-9-]+\.(mjs|html|css|json)$/.test(name)&&name!=='package.json') {
      const info=await lstat(join(root,directory,name));
      if(info.isFile()||info.isSymbolicLink())await copy(`${directory}/${name}`);
    }
  }
}
await copy('deployment/render.yaml','render.yaml');
await copy('HOSTING_PLAN.md','README.md');
await writeFile(join(target,'package.json'),JSON.stringify({name:'pickspot-sharing-test',private:true,type:'module',engines:{node:'24.x'},scripts:{start:'node server/render-server.mjs'}},null,2)+'\n');
await writeFile(join(target,'.gitignore'),'.env*\n.state/\nserver/.state/\nnode_modules/\n*.pem\n*.key\n');
await writeFile(join(target,'SOURCE_MANIFEST.json'),JSON.stringify({purpose:'공유 테스트용 검토 파일. 외부 업로드 안 함.',files:inventory},null,2)+'\n');
console.log(target);
