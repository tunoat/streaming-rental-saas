import { readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';

const canonical=new URL('./openapi.bot-control.v1.yaml',import.meta.url);
const spec=YAML.parse(readFileSync(canonical,'utf8'));
const pathParam=name=>({name,in:'path',required:true,schema:{type:'string',format:'uuid'}});
for (const [path,operations] of Object.entries(spec.paths)) {
  for (const [method,op] of Object.entries(operations)) {
    op.parameters=[...(op.parameters??[...path.matchAll(/\{(\w+)\}/g)].map(match=>pathParam(match[1])))];
    if(method==='post') {
      op.parameters.push(
        {name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[a-zA-Z0-9_-]{8,128}$'}},
        {name:'X-Request-ID',in:'header',required:true,schema:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,128}$'}}
      );
    }
    if (path.includes('{jobId}')) op.responses['404']={description:'Job not found in the authorized scope'};
    for (const [code,response] of Object.entries(op.responses))
      if(Number(code)>=400) response.content={'application/json':{schema:{$ref:'#/components/schemas/Error'}}};
  }
}
spec.info.version='1.0.0-proposed-headers';
spec.info.description='Proposed mock-only HTTP implementation supplement. Cross-team review pending.';
if (process.argv.includes('--write')) writeFileSync(new URL('./openapi.bot-control.v1.headers-proposed.yaml',import.meta.url),YAML.stringify(spec));

