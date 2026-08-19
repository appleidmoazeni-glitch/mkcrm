'use strict';

const { EJSON } = require('bson');
const { connectMongo, closeMongo } = require('../src/lib/mongo');
const reconciliation = require('../src/lib/item-catalog-reconciliation');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function main() {
  const db = await connectMongo();
  const apply = process.argv.includes('--apply');
  if (apply && db.databaseName !== 'mkcrm_staging') throw Object.assign(new Error(`Refusing catalog reconciliation for ${db.databaseName}`), { code:'STAGING_DATABASE_REQUIRED' });
  const result = apply
    ? await reconciliation.apply(db, { planFingerprint:arg('--plan-fingerprint'), backupEvidence:arg('--backup-evidence') })
    : await reconciliation.plan(db);
  process.stdout.write(`${EJSON.stringify({ ok:true, mode:apply?'apply':'plan', database:db.databaseName, result }, { relaxed:true })}\n`);
}

main().catch(error => {
  process.stderr.write(`${EJSON.stringify({ ok:false, code:error.code || 'CATALOG_RECONCILIATION_FAILED', error:String(error.message || error), currentFingerprint:error.currentFingerprint || '' }, { relaxed:true })}\n`);
  process.exitCode = 1;
}).finally(() => closeMongo().catch(() => {}));
