#!/usr/bin/env node
'use strict';

const { connectMongo, closeMongo } = require('../src/lib/mongo');
const recovery = require('../src/lib/purchase-history-recovery');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}
function has(name) { return process.argv.slice(2).includes(`--${name}`); }

async function main() {
  const db = await connectMongo();
  if (!/staging/i.test(db.databaseName)) throw new Error(`Refusing non-staging database: ${db.databaseName}`);
  const result = await recovery.recover(db, {
    fifoDatasetId:option('fifo-dataset'),
    purchaseDatasetId:option('purchase-dataset'),
    maxItems:option('max-items', '25'),
    maxKardexRows:option('max-kardex-rows', '40'),
    timeoutMs:option('timeout-ms', '5000'),
    persist:has('persist'),
    actor:{ username:'fifo-r2-recovery', role:'system' }
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok:false, code:error.code || 'PURCHASE_RECOVERY_FAILED', error:String(error.message || error).slice(0,1000) })}\n`);
  process.exitCode = 1;
}).finally(closeMongo);
