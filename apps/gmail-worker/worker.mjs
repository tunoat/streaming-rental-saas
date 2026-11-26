import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {GmailWorkerClient} from '../../packages/shared/gmail-worker-client.mts';
import {failure,gmailBase,googleJson,loopback} from '../api/gmail-provider.mjs';

export class MockGmailAdapter {
  async inspect(){
    return {provenance:'MOCK',identity_match:true,profile_ok:true,list_ok:true,empty_inbox:true,metadata_read:false};
  }
}

export class GoogleGmailAdapter {
  constructor(send=fetch){this.send=send;}
  async inspect(getToken){
    let credential=await getToken(false);
    let refreshed=false;
    const read=async path=>{
      const request=()=>googleJson(gmailBase+path,{headers:{authorization:'Bearer '+credential.access_token}},this.send);
      try{return await request();}catch(error){
        if(refreshed||error.providerCode!=='TOKEN_REJECTED') throw error;
        refreshed=true;
        credential=await getToken(true);
        return request();
      }
    };
    const profile=await read('/profile?fields=emailAddress');
    if(profile.emailAddress?.toLowerCase()!==credential.email) throw failure('IDENTITY_MISMATCH');
    const list=await read('/messages?labelIds=INBOX&maxResults=1&fields=messages(id),resultSizeEstimate');
    const id=list.messages?.[0]?.id;
    if(list.messages?.length&&(!id||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw failure('EVIDENCE_INVALID');
    if(id){
      const message=await read('/messages/'+encodeURIComponent(id)+'?format=metadata&fields=id');
      if(message.id!==id) throw failure('EVIDENCE_INVALID');
    }
    return {provenance:'LIVE',identity_match:true,profile_ok:true,list_ok:true,empty_inbox:!id,metadata_read:!!id};
  }
}

const knownErrors=new Set(['AUTH_REQUIRED','IDENTITY_MISMATCH','SCOPE_INVALID','PROVIDER_UNAVAILABLE','PROVIDER_REJECTED','TOKEN_REJECTED','EVIDENCE_INVALID']);
export async function runGmailOnce(client,mode='mock',adapter=mode==='mock'?new MockGmailAdapter():new GoogleGmailAdapter()){
  const job=await client.claim();
  if(!job) return null;
  if(job.mode!==mode) throw new Error('Gmail worker mode mismatch');
  const lease={lease_token:job.lease_token,fencing_token:job.fence};
  await client.start(job.id,lease);
  let heartbeat;
  const timer=setInterval(()=>{
    if(!heartbeat) heartbeat=client.heartbeat(job.id,lease).catch(()=>{}).finally(()=>{heartbeat=null;});
  },15000);
  let evidence;
  try{
    evidence=await adapter.inspect(refresh=>client.tokenFor(job.id,lease,refresh));
  }catch(error){
    const reason=knownErrors.has(error.providerCode)?error.providerCode:'PROVIDER_UNAVAILABLE';
    return await client.fail(job.id,lease,job.generation,reason);
  }finally{clearInterval(timer);}
  return client.complete(job.id,lease,{...evidence,generation:job.generation,observed_at:new Date().toISOString()});
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const {GMAIL_ADAPTER:mode='mock',GMAIL_LIVE_TEST_ENABLED, BOT_API_URL='http://127.0.0.1:3000',
    BOT_WORKER_ID,BOT_WORKER_TOKEN,GMAIL_WORKER_STORE_ID}=process.env;
  const url=new URL(BOT_API_URL);
  if(!['mock','live'].includes(mode)||!['http:','https:'].includes(url.protocol)||url.username||url.password||
    !BOT_WORKER_ID||!/^[a-zA-Z0-9_-]{43}$/.test(BOT_WORKER_TOKEN??'')||
    !/^[a-f0-9-]{36}$/i.test(GMAIL_WORKER_STORE_ID??'')||
    mode==='live'&&(GMAIL_LIVE_TEST_ENABLED!=='true'||!loopback(url.hostname)))
    throw new Error('Invalid Gmail worker configuration');
  const client=new GmailWorkerClient(url.origin,BOT_WORKER_TOKEN,BOT_WORKER_ID,GMAIL_WORKER_STORE_ID);
  while(true){
    try{await runGmailOnce(client,mode);}catch{console.error('Gmail worker request failed');}
    await delay(2000);
  }
}
