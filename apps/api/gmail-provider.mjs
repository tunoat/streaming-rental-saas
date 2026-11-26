import {createCipheriv,createDecipheriv,createPublicKey,randomBytes,verify} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';

export const readScope='https://www.googleapis.com/auth/gmail.readonly';
export const gmailBase='https://gmail.googleapis.com/gmail/v1/users/me';
export const loopback = hostname => ['127.0.0.1','localhost','[::1]'].includes(hostname);
export const failure = code => Object.assign(new Error(code),{providerCode:code});
const tokenEndpoint='https://oauth2.googleapis.com/token';
const jwksEndpoint='https://www.googleapis.com/oauth2/v3/certs';

export function gmailConfig(env=process.env){
  const mode=env.GMAIL_ADAPTER??'mock';
  const encoded=env.EMAIL_TOKEN_ENCRYPTION_KEY;
  const version=env.EMAIL_TOKEN_KEY_VERSION??'1';
  if(!['mock','live'].includes(mode)||!/^\d{1,6}$/.test(version)||encoded&&!/^[a-f0-9]{64}$/i.test(encoded))
    throw new Error('Invalid Gmail adapter or encryption configuration');
  let redirect;
  if(mode==='live'){
    if(env.GMAIL_LIVE_TEST_ENABLED!=='true'||!['development','test'].includes(env.NODE_ENV)||
      !loopback(env.HOST??'127.0.0.1')||!encoded||!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)
      throw new Error('Live Gmail requires explicit loopback development configuration');
    redirect=new URL(env.GOOGLE_REDIRECT_URI);
    if(!loopback(redirect.hostname)||!['http:','https:'].includes(redirect.protocol)||
      redirect.pathname!=='/v1/oauth/google/callback'||redirect.search||redirect.hash||redirect.username||redirect.password)
      throw new Error('Invalid Gmail callback URL');
  }
  const key=encoded?Buffer.from(encoded,'hex'):randomBytes(32);
  return {mode,redirect,version,key,clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET};
}

export function seal(config,value,context){
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',config.key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify([config.version,context])));
  const data=Buffer.concat([iv,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);
  return config.version+'.'+data.toString('base64url');
}

export function unseal(config,value,context){
  const [version,encoded,extra]=String(value).split('.');
  if(version!==config.version||!encoded||extra) throw failure('AUTH_REQUIRED');
  try{
    const data=Buffer.from(encoded,'base64url');
    const decipher=createDecipheriv('aes-256-gcm',config.key,data.subarray(0,12));
    decipher.setAAD(Buffer.from(JSON.stringify([version,context])));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]));
  }catch{throw failure('AUTH_REQUIRED');}
}

export async function googleFetch(url,options={},send=fetch){
  for(let attempt=0;attempt<3;attempt++){
    let response;
    try{
      response=await send(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
    }catch{
      if(attempt===2) throw failure('PROVIDER_UNAVAILABLE');
    }
    if(response?.ok) return response;
    if(response?.status===401) throw failure('TOKEN_REJECTED');
    if(response?.status===403) throw failure('AUTH_REQUIRED');
    if(response&&response.status!==429&&response.status<500){
      const body=await response.json().catch(()=>({}));
      throw failure(body.error==='invalid_grant'?'AUTH_REQUIRED':'PROVIDER_REJECTED');
    }
    if(attempt===2) throw failure('PROVIDER_UNAVAILABLE');
    const header=response?.headers.get('retry-after');
    const retry=header&&/^\d+$/.test(header)?Number(header)*1000:Date.parse(header??'')-Date.now();
    if(retry>5000) throw failure('PROVIDER_UNAVAILABLE');
    await wait(Number.isFinite(retry)&&retry>0?retry:250*2**attempt);
  }
}

export async function googleJson(url,options,send){
  const response=await googleFetch(url,options,send);
  try{return await response.json();}catch{throw failure('PROVIDER_REJECTED');}
}

export function googleAuthorization(config,state,nonce,challenge){
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirect.href,response_type:'code',
    scope:'openid email '+readScope,access_type:'offline',prompt:'consent',state,nonce,code_challenge:challenge,code_challenge_method:'S256'});
  return url.href;
}

async function googleToken(config,params,send){
  const data=await googleJson(tokenEndpoint,{method:'POST',body:new URLSearchParams({
    ...params,client_id:config.clientId,client_secret:config.clientSecret})},send);
  if(typeof data.access_token!=='string'||data.token_type?.toLowerCase()!=='bearer'||
      !Number.isFinite(data.expires_in)||data.expires_in<1) throw failure('AUTH_REQUIRED');
  return {...data,expires_at:new Date(Date.now()+data.expires_in*1000).toISOString()};
}

export async function googleIdentity(token,config,nonce,send){
  const parts=String(token).split('.');
  if(parts.length!==3) throw failure('IDENTITY_INVALID');
  let header,claims;
  try{
    header=JSON.parse(Buffer.from(parts[0],'base64url'));
    claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  }catch{throw failure('IDENTITY_INVALID');}
  if(header.alg!=='RS256'||typeof header.kid!=='string') throw failure('IDENTITY_INVALID');
  const {keys}=await googleJson(jwksEndpoint,{},send);
  const jwk=keys?.find(key=>key.kid===header.kid&&key.kty==='RSA'&&key.use==='sig');
  let valid=false;
  try{
    valid=!!jwk&&verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),
      createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url'));
  }catch{}
  if(!valid||!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||claims.aud!==config.clientId||
    claims.azp!==undefined&&claims.azp!==config.clientId||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000||
    claims.nonce!==nonce||claims.email_verified!==true||typeof claims.sub!=='string'||!claims.sub||
    typeof claims.email!=='string') throw failure('IDENTITY_INVALID');
  return claims;
}

export async function exchangeGoogle(config,code,{verifier,nonce},expected,send){
  const token=await googleToken(config,{code,grant_type:'authorization_code',code_verifier:verifier,
    redirect_uri:config.redirect.href},send);
  const scopes=String(token.scope??'').split(' ').filter(Boolean);
  const allowed=new Set(['openid','email','https://www.googleapis.com/auth/userinfo.email',readScope]);
  if(!scopes.includes(readScope)||scopes.some(scope=>!allowed.has(scope))) throw failure('SCOPE_INVALID');
  const identity=await googleIdentity(token.id_token,config,nonce,send);
  if(identity.email.toLowerCase()!==expected) throw failure('IDENTITY_MISMATCH');
  const profile=await googleJson(gmailBase+'/profile?fields=emailAddress',{headers:{authorization:'Bearer '+token.access_token}},send);
  if(profile.emailAddress?.toLowerCase()!==expected) throw failure('IDENTITY_MISMATCH');
  return {token:{access:token.access_token,refresh:token.refresh_token,expires:token.expires_at},
    subject:identity.sub,scopes};
}

export async function refreshGoogle(config,refresh,send){
  const token=await googleToken(config,{refresh_token:refresh,grant_type:'refresh_token'},send);
  if(token.scope&&!token.scope.split(' ').includes(readScope)) throw failure('SCOPE_INVALID');
  return {access:token.access_token,refresh:token.refresh_token??refresh,expires:token.expires_at};
}

export async function revokeGoogle(token,send){
  await googleFetch('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token})},send);
}
