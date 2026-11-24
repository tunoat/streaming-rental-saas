import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { setLanguage, t } from '../apps/admin-web/i18n.js';

test('every Thai UI label has an English translation',()=>{
  const app=readFileSync(new URL('../apps/admin-web/app.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../apps/admin-web/index.html',import.meta.url),'utf8');
  const ast=ts.createSourceFile('app.js',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const keys=new Set(Array.from(html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g),match=>match[1]));
  function collect(node) {
    if (ts.isStringLiteral(node)&&/[\u0e01-\u0e4e]/.test(node.text)&&node.text!=='ไทย') keys.add(node.text);
    ts.forEachChild(node,collect);
  }
  collect(ast);
  setLanguage('en');
  for(const key of keys) assert.notEqual(t(key),key,'Missing English translation for '+key);
  setLanguage('th');
  for(const key of keys) assert.equal(t(key),key);
});
