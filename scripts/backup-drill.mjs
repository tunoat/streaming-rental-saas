import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const container=process.argv[2];
if (!/^[\w-]+$/.test(container??'')) throw new Error('Provide the name of a disposable PostgreSQL container');
const suffix=randomBytes(6).toString('hex');
const target='restore_check_'+suffix;
const dump='/tmp/'+target+'.dump';
const started=Date.now();
const docker=(...args)=>execFileSync('docker',['exec',container,...args],{encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();
const countQuery=`SELECT jsonb_build_array((SELECT count(*) FROM migration_history),(SELECT count(*) FROM stores),
  (SELECT count(*) FROM jobs),(SELECT count(*) FROM wallet_ledger),(SELECT count(*) FROM rentals))`;
const counts=database=>docker('psql','-XAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,'-c',countQuery);
const original=counts('postgres');
let created=false;
try {
  docker('pg_dump','-U','postgres','-Fc','-f',dump,'postgres');
  docker('createdb','-U','postgres',target);
  created=true;
  docker('pg_restore','--exit-on-error','-U','postgres','-d',target,dump);
  const restored=counts(target);
  if (original!==restored) throw new Error('Restored control totals do not match');
  console.log('Restore matched migration, store, job, ledger and rental row counts in '+(Date.now()-started)+' ms');
} finally {
  if (created) docker('dropdb','-U','postgres',target);
  docker('rm','-f',dump);
}

