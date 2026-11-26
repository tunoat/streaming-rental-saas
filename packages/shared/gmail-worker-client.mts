import type { components } from './gmail-contract.js';
type Schema=components['schemas'];

export class GmailWorkerClient {
  readonly base: string;
  readonly token: string;
  readonly workerId: string;
  constructor(base: string, token: string, workerId: string, storeId: string){
    this.base=base+'/v1/email-worker/stores/'+encodeURIComponent(storeId)+'/jobs/';
    this.token=token;
    this.workerId=workerId;
  }
  private async request<T>(path: string, params: object): Promise<T>{
    const reply=await fetch(this.base+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(35000),
      headers:{authorization:'Bearer '+this.token,'content-type':'application/json',
        'idempotency-key':crypto.randomUUID(),'x-request-id':crypto.randomUUID()},
      body:JSON.stringify({...params,worker_id:this.workerId})});
    if(!reply.ok){
      const data=await reply.json().catch(()=>null) as {code?:unknown}|null;
      const code=typeof data?.code==='string'&&/^[A-Z_]{1,64}$/.test(data.code)?data.code:'PROVIDER_UNAVAILABLE';
      throw Object.assign(new Error(code),{providerCode:code});
    }
    return (reply.status===204?null:await reply.json()) as T;
  }
  claim(){return this.request<Schema['Claim']|null>('claim',{});}
  start(id:string,lease:Omit<Schema['Lease'],'worker_id'>){return this.request(id+'/start',lease);}
  heartbeat(id:string,lease:Omit<Schema['Lease'],'worker_id'>){return this.request(id+'/heartbeat',lease);}
  tokenFor(id:string,lease:Omit<Schema['Lease'],'worker_id'>,refresh=false){
    return this.request<Schema['AccessToken']>(id+'/access-token',{...lease,refresh});
  }
  complete(id:string,lease:Omit<Schema['Lease'],'worker_id'>,evidence:Omit<Schema['Verification'],'worker_id'|'lease_token'|'fencing_token'>){
    return this.request(id+'/complete',{...lease,...evidence});
  }
  fail(id:string,lease:Omit<Schema['Lease'],'worker_id'>,generation:number,error:string){
    return this.request(id+'/fail',{...lease,generation,error});
  }
}
