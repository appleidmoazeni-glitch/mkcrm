#!/usr/bin/env node
'use strict';

const { connectMongo, closeMongo } = require('../src/lib/mongo');
const basis = require('../src/lib/opening-accounting-cost-basis');

function option(name, fallback='') {
  const prefix=`--${name}=`;
  const value=process.argv.slice(2).find(argument=>argument.startsWith(prefix));
  return value?value.slice(prefix.length):fallback;
}

async function main() {
  const itemCodes=option('items').split(',').map(value=>value.trim()).filter(Boolean);
  if(!itemCodes.length||itemCodes.length>25)throw new Error('Provide 1..25 item codes with --items=CODE1,CODE2');
  const db=await connectMongo();
  if(!/staging/i.test(db.databaseName)&&process.env.ALLOW_NON_STAGING_OPENING_BASIS!=='true')throw new Error(`Refusing non-staging database: ${db.databaseName}`);
  const results=[];
  for(const itemCode of itemCodes)results.push(await basis.materialize(db,{itemCode},{maxRows:Number(option('max-rows','100')),timeoutMs:Number(option('timeout-ms','5000'))}));
  process.stdout.write(`${JSON.stringify({ok:results.every(row=>row.ok),diagnosticOnly:true,purchaseLayerWrites:0,fifoWrites:0,results},null,2)}\n`);
}

main().catch(error=>{process.stderr.write(`${JSON.stringify({ok:false,code:error.code||'OPENING_BASIS_MATERIALIZE_FAILED',error:String(error.message||error).slice(0,1000)})}\n`);process.exitCode=1;}).finally(closeMongo);
