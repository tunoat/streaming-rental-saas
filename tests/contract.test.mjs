import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { operations, openapi } from '../apps/api/contract.mjs';

test('canonical OpenAPI export matches embedded bytes and compiles all 11 operation schemas',()=>{
  const original=readFileSync('CODEX_MASTER_PROMPT_STREAMING_SAAS_V4_WITH_BOT_API.md').toString('latin1');
  const yaml=original.match(/\x60{3}yaml\r?\n([\s\S]*?)\x60{3}\r?\n/)[1];
  assert.deepEqual(readFileSync('contracts/openapi.bot-control.v1.yaml'),Buffer.from(yaml,'latin1'));
  assert.equal(openapi.openapi,'3.1.0');
  assert.equal(operations.length,11);
  assert.equal(operations.filter(op=>op.body).length,8);
});

