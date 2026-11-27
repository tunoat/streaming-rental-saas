import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { authenticate, pool, transaction } from './db.mjs';
import { registerAdmin } from './admin.mjs';
import { registerJobs, uuid } from './jobs.mjs';
import { registerWorkflow } from './workflow.mjs';
import { registerGmail } from './gmail.mjs';
import { registerNetflixBindings } from './netflix-bindings.mjs';
import { registerNetflixOwnerAssist } from './netflix-owner-assist.mjs';
import { gmailConfig } from './gmail-provider.mjs';

export async function appServer(gmailTest) {
  if (process.env.NODE_ENV==='production') throw new Error('The Phase 1 demo cannot run in production');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  for (const [flag,allowed] of Object.entries({BANK_ADAPTER:'mock',STREAMING_ADAPTER:'mock',EMAIL_DELIVERY:'disabled',CUSTOMER_AUTH:'disabled'}))
    if ((process.env[flag]??allowed)!==allowed) throw new Error('Unsupported '+flag);
  const app=Fastify({bodyLimit:32768,requestIdHeader:false,genReqId:req=>/^[\w-]{1,128}$/.test(req.headers['x-request-id']??'')?req.headers['x-request-id']:randomUUID()});
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('x-request-id',req.id).header('cache-control','no-store').header('x-content-type-options','nosniff')
      .header('content-security-policy',"default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((err,req,reply)=>{
    const status=err.statusCode>=400&&err.statusCode<500?err.statusCode:['23503','23505','23514'].includes(err.code)?409:500;
    reply.code(status).send({code:err.errorCode??(status===409?'CONFLICT':status===500?'INTERNAL_ERROR':'INVALID_REQUEST'),
      message:err.errorCode??(status===500?'Unexpected server error':'Request rejected'),request_id:req.id});
  });
  app.get('/health',()=>({ok:true}));
  app.get('/ready',async(_req,reply)=>{
    try { await pool.query('SELECT id FROM admin_guard LIMIT 1'); } catch { return reply.code(503).send({ok:false}); }
    return {ok:true};
  });
  app.get('/openapi.bot-control.v1.yaml',(_req,reply)=>reply.type('application/yaml').send(readFileSync(new URL('../../contracts/openapi.bot-control.v1.yaml',import.meta.url))));
  app.get('/openapi.bot-control.v1.headers-proposed.yaml',(_req,reply)=>reply.type('application/yaml').send(readFileSync(new URL('../../contracts/openapi.bot-control.v1.headers-proposed.yaml',import.meta.url))));
  const secured=(method,url,fn,worker=false,send=(reply,result)=>reply.send(result))=>{
    app.route({method,url,handler:async(req,reply)=>{
      for (const [name,value] of Object.entries(req.params)) if (name.endsWith('Id')&&!uuid.test(value)) return reply.code(400).send({code:'INVALID_ID',message:'Invalid identifier',request_id:req.id});
      const result=await transaction(async q=>fn(q,await authenticate(q,req,worker),req,reply));
      return send(reply,result);
    }});
  };
  registerAdmin(app,secured);
  registerJobs(secured);
  registerWorkflow(secured);
  registerNetflixBindings(secured);
  app.get('/openapi.netflix-binding.v1.yaml',(_req,reply)=>reply.type('application/yaml').send(readFileSync(new URL('../../contracts/openapi.netflix-binding.v1.yaml',import.meta.url))));
  if(gmailTest&&process.env.NODE_ENV!=='test') throw new Error('Gmail injection is restricted to tests');
  const gmail=gmailTest?.config??gmailConfig();
  registerGmail(app,secured,gmail,gmailTest?.provider);
  registerNetflixOwnerAssist(secured,gmail);
  app.get('/openapi.email-bot.v1.yaml',(_req,reply)=>reply.type('application/yaml').send(readFileSync(new URL('../../contracts/openapi.email-bot.v1.yaml',import.meta.url))));
  await app.register(staticFiles,{root:fileURLToPath(new URL('../admin-web/',import.meta.url))});
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const app=await appServer();
  await app.listen({port:Number(process.env.PORT??3000),host:process.env.HOST??'127.0.0.1'});
  console.info('Phase 1 mock API is listening');
}

