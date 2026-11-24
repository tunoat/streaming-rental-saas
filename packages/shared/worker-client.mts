import type { components } from './bot-contract.js';

type Schema = components['schemas'];
type Lease = Schema['Heartbeat'];
type Job = Schema['Job'];
type Result = Schema['JobResult'];
type Claim = Schema['ClaimResponse'];

export class WorkerClient {
  readonly base: string;
  readonly token: string;
  readonly workerId: string;

  constructor(base: string, token: string, workerId: string) {
    this.base = base;
    this.token = token;
    this.workerId = workerId;
  }
  private async request<T>(path: string, body?: object, key = crypto.randomUUID()): Promise<T> {
    const headers: Record<string,string> = {authorization:'Bearer '+this.token,'x-request-id':crypto.randomUUID()};
    if (body) {
      headers['idempotency-key']=key;
      headers['content-type']='application/json';
    }
    const response = await fetch(this.base + '/v1/worker/jobs/' + path,{
      method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',
      signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as {code?: unknown} | null;
      const code = typeof payload?.code === 'string' && /^[A-Z_]{1,64}$/.test(payload.code) ? ' '+payload.code : '';
      throw new Error('Worker API HTTP '+response.status+code);
    }
    return (response.status===204?null:await response.json()) as T;
  }
  claim(capabilities: Job['type'][], key?: ReturnType<typeof crypto.randomUUID>) {
    return this.request<Claim|null>('claim',{worker_id:this.workerId,capabilities,max_jobs:1},key);
  }
  get(id: string) { return this.request<Job>(encodeURIComponent(id)); }
  start(id: string, lease: Lease) { return this.request<Job>(encodeURIComponent(id)+'/start',lease); }
  heartbeat(id: string, lease: Lease) { return this.request<Job>(encodeURIComponent(id)+'/heartbeat',lease); }
  report(id: string, result: Result, key?: ReturnType<typeof crypto.randomUUID>) {
    return this.request<Job>(encodeURIComponent(id)+(result.outcome==='PASS'?'/complete':'/fail'),result,key);
  }
}

