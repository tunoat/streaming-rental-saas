import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const folder of ['apps','contracts','database','packages','scripts','tests']) {
  for (const file of readdirSync(folder,{recursive:true}).filter(path=>/\.(mjs|js)$/.test(path))) {
    const result=spawnSync(process.execPath,['--check',join(folder,file)],{stdio:'inherit'});
    if (result.error || result.status!==0) process.exit(1);
  }
}

