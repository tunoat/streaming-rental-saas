import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {membership,reject} from './db.mjs';
import {lockStore} from './jobs.mjs';
import {createInventoryAccount} from './workflow.mjs';
import {gmailBase,googleJson,refreshGoogle,seal,unseal} from './gmail-provider.mjs';

const path='/v1/stores/:storeId/email-addresses/:emailId/netflix-assist';
const netflixSender='info@account.netflix.com';
const destinations={netflix:'https://www.netflix.com/login',gmail:'https://mail.google.com/mail/u/0/#inbox'};
const terminal=(row)=>({status:row.found_at?'FOUND':row.expires_at<=new Date()?'EXPIRED':'WAITING',
  expires_at:row.expires_at.toISOString()});
const context=(store,email,generation)=>['gmail-vault',store,email,generation];

export async function hasNewNetflixMail(token,since,send){
  const headers={authorization:'Bearer '+token};
  const filter=new URLSearchParams({labelIds:'INBOX',maxResults:'3',fields:'messages(id)',
    q:'from:'+netflixSender+' after:'+Math.floor(since.getTime()/1000)});
  const list=await googleJson(gmailBase+'/messages?'+filter,{headers},send);
  for(const message of list.messages?.slice(0,3)??[]){
    if(typeof message.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(message.id)) continue;
    const query=new URLSearchParams({format:'metadata',metadataHeaders:'From',fields:'internalDate,payload(headers)'});
    const detail=await googleJson(gmailBase+'/messages/'+encodeURIComponent(message.id)+'?'+query,{headers},send);
    const from=detail.payload?.headers?.find(h=>h.name?.toLowerCase()==='from')?.value?.trim().toLowerCase()??'';
    const address=from.match(/<([^<>]+)>$/)?.[1]??from;
    if(address===netflixSender&&Number(detail.internalDate)>=since.getTime()) return true;
  }
  return false;
}

function chromeExecutable(){
  return [process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean)
    .map(root=>join(root,'Google','Chrome','Application','chrome.exe')).find(existsSync);
}

export function chromeProfileArgument(localAppData,store,emailId,address,overrides,read=readFileSync){
  const selected=JSON.parse(overrides||'{}')[store+'/'+emailId];
  if(selected===undefined) return '--user-data-dir='+join(localAppData,'StreamingRental','ChromeProfiles',store,emailId);
  if(typeof selected!=='string'||!/^(Default|Profile [1-9][0-9]*)$/.test(selected)) throw new Error('Invalid Chrome profile mapping');
  const data=JSON.parse(read(join(localAppData,'Google','Chrome','User Data','Local State'),'utf8'));
  const profile=data.profile?.info_cache?.[selected];
  if(profile?.user_name?.trim().toLowerCase()!==address.trim().toLowerCase()) throw new Error('Chrome profile email mismatch');
  return '--profile-directory='+selected;
}

export function chromeLaunchArguments(profileArgument,destination){
  return [profileArgument,'--no-first-run',...(destination==='netflix'?['--new-window']:[]),destinations[destination]];
}

async function launchChrome(executable,profileArgument,destination){
  const child=spawn(executable,chromeLaunchArguments(profileArgument,destination),
    {shell:false,detached:true,stdio:'ignore'});
  await new Promise((resolve,rejectLaunch)=>{child.once('spawn',resolve);child.once('error',rejectLaunch);});
  child.unref();
}

export function registerNetflixOwnerAssist(secured,config){
  async function owner(q,auth,req){
    const {storeId:store,emailId:email}=req.params;
    await membership(q,auth,store,['OWNER']);
    await lockStore(q,store);
    const {rows:[row]}=await q(`SELECT e.email,g.generation,g.status,g.mode,g.evidence,v.encrypted_tokens
      FROM streaming_email_addresses e LEFT JOIN gmail_connections g
        ON (g.store_id,g.email_id,g.email)=(e.store_id,e.id,e.email)
      LEFT JOIN gmail_vault v ON (v.store_id,v.email_id)=(g.store_id,g.email_id)
      WHERE (e.store_id,e.id)=($1,$2) AND e.archived_at IS NULL`,[store,email]);
    if(!row) reject(404,'EMAIL_NOT_FOUND');
    return {store,email,row};
  }
  function requireLive(row){
    if(config.mode!=='live'||row.mode!=='live'||row.status!=='CONNECTED'||
      row.evidence?.provenance!=='LIVE'||row.evidence?.identity_match!==true||!row.encrypted_tokens)
      reject(409,'GMAIL_WATCH_NOT_READY');
  }
  secured('GET',path+'/owner-result',async(q,auth,req)=>{
    const {store,email}=await owner(q,auth,req);
    const {rows:[row]}=await q('SELECT entered,confirmed_at FROM netflix_owner_confirmation WHERE (store_id,email_id)=($1,$2)',[store,email]);
    return row??{entered:null,confirmed_at:null};
  });
  secured('POST',path+'/owner-result',async(q,auth,req)=>{
    const {store,email,row:entry}=await owner(q,auth,req);
    const entered=req.body?.entered;
    if(typeof entered!=='boolean'||Object.keys(req.body).length!==1) reject(400,'INVALID_REQUEST');
    let account;
    if(entered){
      ({rows:[account]}=await q(`SELECT id FROM accounts WHERE store_id=$1 AND email=$2 AND platform='netflix'
        AND archived_at IS NULL`,[store,entry.email]));
      if(!account){
        const {rows:[active]}=await q("SELECT plan FROM stores WHERE id=$1 AND status='ACTIVE' AND expires_at>now()",[store]);
        if(!active) reject(409,'STORE_NOT_OPEN_FOR_SALES');
        account=await createInventoryAccount(q,store,'netflix',entry.email,5,active.plan);
      }
    }
    const {rows:[row]}=await q(`INSERT INTO netflix_owner_confirmation(store_id,email_id,entered)
      VALUES($1,$2,$3) ON CONFLICT(store_id,email_id) DO UPDATE
      SET entered=excluded.entered,confirmed_at=CASE WHEN netflix_owner_confirmation.entered=excluded.entered
        THEN netflix_owner_confirmation.confirmed_at ELSE clock_timestamp() END RETURNING entered,confirmed_at`,[store,email,entered]);
    return {...row,account_id:account?.id??null};
  });
  secured('POST',path+'/chrome',async(q,auth,req)=>{
    const {store,email,row}=await owner(q,auth,req);
    if(process.env.NETFLIX_LOCAL_CHROME_ENABLED!=='yes'||process.platform!=='win32'||
      (process.env.HOST??'127.0.0.1')!=='127.0.0.1'||req.ip!=='127.0.0.1'||!process.env.LOCALAPPDATA)
      reject(403,'LOCAL_CHROME_UNAVAILABLE');
    const executable=chromeExecutable();
    if(!executable) reject(404,'LOCAL_CHROME_UNAVAILABLE');
    const destination=req.body?.destination??'netflix';
    if(typeof destination!=='string'||!Object.hasOwn(destinations,destination)) reject(400,'INVALID_REQUEST');
    let profileArgument;
    try{profileArgument=chromeProfileArgument(process.env.LOCALAPPDATA,store,email,row.email,process.env.NETFLIX_CHROME_PROFILE_OVERRIDES);}
    catch{reject(409,'LOCAL_CHROME_PROFILE_MISMATCH');}
    return {executable,destination,profileArgument};
  },false,async(reply,{executable,profileArgument,destination})=>{
    try{await launchChrome(executable,profileArgument,destination);}catch{reject(503,'LOCAL_CHROME_UNAVAILABLE');}
    return reply.send({opened:true});
  });
  secured('POST',path+'/watch/start',async(q,auth,req)=>{
    const {store,email,row}=await owner(q,auth,req);
    requireLive(row);
    const {rows:[watch]}=await q(`INSERT INTO netflix_mail_watch(store_id,email_id,gmail_generation,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '3 minutes')
      ON CONFLICT(store_id,email_id) DO UPDATE SET gmail_generation=excluded.gmail_generation,
      started_at=excluded.started_at,expires_at=excluded.expires_at,checked_at=NULL,found_at=NULL
      WHERE netflix_mail_watch.found_at IS NOT NULL OR netflix_mail_watch.expires_at<=clock_timestamp()
        OR netflix_mail_watch.gmail_generation<>excluded.gmail_generation
      RETURNING *`,[store,email,row.generation]);
    if(watch) return terminal(watch);
    const {rows:[existing]}=await q('SELECT * FROM netflix_mail_watch WHERE (store_id,email_id)=($1,$2)',[store,email]);
    return terminal(existing);
  });
  secured('POST',path+'/watch/check',async(q,auth,req)=>{
    const {store,email,row}=await owner(q,auth,req);
    requireLive(row);
    const {rows:[watch]}=await q('SELECT * FROM netflix_mail_watch WHERE (store_id,email_id,gmail_generation)=($1,$2,$3)',[store,email,row.generation]);
    if(!watch) reject(409,'GMAIL_WATCH_NOT_STARTED');
    const state=terminal(watch);
    if(state.status!=='WAITING'||watch.checked_at&&Date.now()-watch.checked_at.getTime()<9500) return [200,state];
    await q('UPDATE netflix_mail_watch SET checked_at=clock_timestamp() WHERE (store_id,email_id)=($1,$2)',[store,email]);
    const vaultContext=context(store,email,row.generation);
    try{
      let token=unseal(config,row.encrypted_tokens,vaultContext);
      const renew=async()=>{
        token=await refreshGoogle(config,token.refresh);
        await q('UPDATE gmail_vault SET encrypted_tokens=$3,expires_at=$4 WHERE (store_id,email_id)=($1,$2)',
          [store,email,seal(config,token,vaultContext),token.expires]);
      };
      if(Date.parse(token.expires)<=Date.now()+30000) await renew();
      let found;
      try{found=await hasNewNetflixMail(token.access,watch.started_at);}
      catch(error){
        if(error.providerCode!=='TOKEN_REJECTED') throw error;
        await renew();
        found=await hasNewNetflixMail(token.access,watch.started_at);
      }
      if(!found) return [200,state];
      await q('UPDATE netflix_mail_watch SET found_at=clock_timestamp() WHERE (store_id,email_id)=($1,$2)',[store,email]);
      return [200,{...state,status:'FOUND'}];
    }catch(error){
      return ['AUTH_REQUIRED','TOKEN_REJECTED','SCOPE_INVALID'].includes(error.providerCode)?
        [409,{code:'GMAIL_WATCH_NOT_READY'}]:[503,{code:'GMAIL_WATCH_UNAVAILABLE'}];
    }
  },false,(reply,[code,body])=>reply.code(code).send(body));
}
