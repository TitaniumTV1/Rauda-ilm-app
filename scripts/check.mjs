import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
let failed=false;
for(const file of [...walk('backend/src'),...walk('frontend')].filter(f=>/\.m?js$/.test(f))){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)failed=true;}
for(const file of walk('frontend').filter(f=>f.endsWith('.html'))){
  const source=readFileSync(file,'utf8');
  for(const match of source.matchAll(/<script[^>]*src="([^"]+)"/g)){if(match[1].startsWith('/assets/'))readFileSync('frontend'+match[1]);}
}
if(failed)process.exit(1);
console.log('JavaScript syntax and local HTML script references verified.');
