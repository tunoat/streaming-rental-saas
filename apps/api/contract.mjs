import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const canonical = new URL('../../contracts/openapi.bot-control.v1.yaml', import.meta.url);
export const openapi = YAML.parse(readFileSync(canonical,'utf8'));
const ajv = new Ajv({strict:false});
addFormats(ajv);
const schemas = { components: openapi.components };
ajv.addSchema(schemas,'urn:bot:control');
const rewrite = value => JSON.parse(JSON.stringify(value).replaceAll('"#/components/','"urn:bot:control#/components/'));
export const operations = Object.entries(openapi.paths).flatMap(([path, entries]) =>
  Object.entries(entries).map(([method, op]) => ({
    path, method:method.toUpperCase(), route:path.replace(/\{(\w+)\}/g,':$1'),
    parameters:op.parameters ?? (path.includes('{jobId}')?[{name:'jobId'}]:[]),
    body:op.requestBody && ajv.compile(rewrite(op.requestBody.content['application/json'].schema)),
    schemas:Object.fromEntries(Object.entries(op.responses).filter(([,res]) => res.content).map(([code,res]) =>
      [code,ajv.compile(rewrite(res.content['application/json'].schema))]))
  })));
export const jobTypes = openapi.components.schemas.Job.properties.type.enum;
export const jobStatuses = openapi.components.schemas.Job.properties.status.enum;

