'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {MemoryDb}=require('./helpers/memory-mongo');
const governorModule=require('../src/lib/opening-extraction-resource-governor');
const opening=require('../src/lib/opening-accounting-cost-basis');
const traffic=require('../src/lib/operational-traffic-health');
const shaygan=require('../src/lib/shaygan');

function dbSeed(extra={}){return new MemoryDb({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:'',lastCycle:{timeouts:0}}}],...extra});}
function testOptions(extra={}){return {testMode:true,minimumDelayMs:0,callsPerMinute:60000,cooldownMs:30000,sleep:async()=>{},...extra};}

test('execution window parser distinguishes disabled, valid and fail-closed configurations without numeric coercion',()=>{
  for(const pair of [[null,null],[undefined,undefined],['',''],['   ','\t']]){
    const parsed=governorModule.executionWindowConfig(pair[0],pair[1],'TEST');assert.equal(parsed.valid,true);assert.equal(parsed.windowRestrictionEnabled,false);assert.equal(parsed.configuredStartHour,null);assert.equal(parsed.configuredEndHour,null);
  }
  for(const pair of [[8,undefined],[undefined,12],['8',''],['','12'],['bad','12'],['8','noon'],[-1,12],[8,24],[8.5,12],[8,8]]){
    const parsed=governorModule.executionWindowConfig(pair[0],pair[1],'TEST');assert.equal(parsed.valid,false,`expected invalid window ${JSON.stringify(pair)}`);assert.equal(parsed.windowRestrictionEnabled,true);
  }
  const daytime=governorModule.executionWindowConfig('08','12','ENVIRONMENT');assert.deepEqual({valid:daytime.valid,start:daytime.configuredStartHour,end:daytime.configuredEndHour,mode:daytime.mode,source:daytime.configurationSource},{valid:true,start:8,end:12,mode:'daytime',source:'ENVIRONMENT'});
  const overnight=governorModule.executionWindowConfig(22,6,'REQUEST');assert.deepEqual({valid:overnight.valid,start:overnight.configuredStartHour,end:overnight.configuredEndHour,mode:overnight.mode},{valid:true,start:22,end:6,mode:'overnight'});
});

test('environment configuration preserves absent and empty window endpoints for explicit parsing',()=>{
  const code=`const {config}=require('./src/lib/config');process.stdout.write(JSON.stringify([config.openingExtractionAllowedStartHour,config.openingExtractionAllowedEndHour]))`;
  const absentEnv={...process.env};delete absentEnv.OPENING_EXTRACTION_ALLOWED_START_HOUR;delete absentEnv.OPENING_EXTRACTION_ALLOWED_END_HOUR;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath,['-e',code],{cwd:require('node:path').resolve(__dirname,'..'),env:absentEnv,encoding:'utf8'})),[null,null]);
  const emptyEnv={...process.env,OPENING_EXTRACTION_ALLOWED_START_HOUR:'',OPENING_EXTRACTION_ALLOWED_END_HOUR:''};
  assert.deepEqual(JSON.parse(execFileSync(process.execPath,['-e',code],{cwd:require('node:path').resolve(__dirname,'..'),env:emptyEnv,encoding:'utf8'})),['','']);
});

test('disabled execution window is explicit in telemetry and never raises outside-window pause',async()=>{
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-NO-WINDOW',testOptions({ownerId:'no-window',allowedStartHour:null,allowedEndHour:null,windowConfigurationSource:'NONE',now:()=>new Date('2026-08-31T04:30:00Z')}));await g.acquire();const health=await g.preflight();
  assert.equal(health.ok,true);assert.equal(health.window.windowRestrictionEnabled,false);assert.equal(health.window.windowEvaluation,'NO_EXECUTION_WINDOW_RESTRICTION');assert.equal(health.window.configuredStartHour,null);assert.equal(health.window.configuredEndHour,null);assert.equal(health.window.timezone,'Asia/Tehran');assert.equal(health.window.configurationSource,'NONE');
  const status=await governorModule.runtimeStatus(db,'OACD-NO-WINDOW');assert.equal(status.runtime.health.window.windowEvaluation,'NO_EXECUTION_WINDOW_RESTRICTION');
});

test('daytime and overnight windows use inclusive start and exclusive end boundaries',async()=>{
  const evaluate=(date,start,end)=>governorModule.createGovernor(dbSeed(),'OACD-WINDOW-'+date,testOptions({allowedStartHour:start,allowedEndHour:end,windowConfigurationSource:'TEST'})).evaluateWindow(new Date(date));
  assert.equal(evaluate('2026-08-31T04:30:00Z',8,12).allowed,true,'daytime start is inclusive');
  assert.equal(evaluate('2026-08-31T08:29:59Z',8,12).allowed,true,'daytime before end is inside');
  assert.equal(evaluate('2026-08-31T08:30:00Z',8,12).allowed,false,'daytime end is exclusive');
  assert.equal(evaluate('2026-08-31T19:30:00Z',22,6).allowed,true,'overnight start is inclusive');
  assert.equal(evaluate('2026-08-31T01:30:00Z',22,6).allowed,true,'overnight after midnight is inside');
  assert.equal(evaluate('2026-08-31T02:30:00Z',22,6).allowed,false,'overnight end is exclusive');
  assert.equal(evaluate('2026-08-31T08:30:00Z',22,6).allowed,false,'overnight daytime is outside');
});

test('invalid or outside execution windows fail closed before any source call',async()=>{
  for(const options of [{allowedStartHour:8,allowedEndHour:null},{allowedStartHour:'bad',allowedEndHour:12},{allowedStartHour:8,allowedEndHour:8}]){
    const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-INVALID-'+String(options.allowedStartHour),testOptions({...options,ownerId:JSON.stringify(options)}));await g.acquire();await assert.rejects(g.preflight(),error=>error.code==='OPENING_INVALID_WINDOW_CONFIGURATION');
  }
  const db=dbSeed(),outside=governorModule.createGovernor(db,'OACD-OUTSIDE',testOptions({ownerId:'outside',allowedStartHour:8,allowedEndHour:12,now:()=>new Date('2026-08-31T08:30:00Z')}));await outside.acquire();await assert.rejects(outside.preflight(),error=>error.code==='OPENING_OUTSIDE_ALLOWED_WINDOW');
});

test('single durable lease fails closed for a duplicate owner and may be reclaimed only after expiry',async()=>{
  let now=new Date('2026-08-31T00:00:00Z');const db=dbSeed();
  const first=governorModule.createGovernor(db,'OACD-1',testOptions({ownerId:'worker-a',now:()=>now,leaseMs:30000}));await first.acquire();
  const duplicate=governorModule.createGovernor(db,'OACD-1',testOptions({ownerId:'worker-b',now:()=>now,leaseMs:30000}));
  await assert.rejects(duplicate.acquire(),error=>error.code==='OPENING_EXTRACTION_LEASE_HELD');
  now=new Date(now.getTime()+30001);await duplicate.acquire();
  const lease=await db.collection(governorModule.LEASES).findOne({scopeKey:governorModule.SCOPE_KEY});assert.equal(lease.ownerId,'worker-b');assert.equal(lease.datasetId,'OACD-1');
});

test('normal source latency keeps breaker closed and persists bounded telemetry',async()=>{
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-NORMAL',testOptions({ownerId:'normal'}));await g.acquire();await g.preflight();
  for(let i=0;i<5;i++){await g.beforeCall({rowStart:i});await g.afterCall({success:true,durationMs:100+i});}
  const status=await governorModule.runtimeStatus(db,'OACD-NORMAL');assert.equal(status.runtime.breakerState,'closed');assert.equal(status.runtime.rolling.calls,5);assert.equal(status.runtime.rolling.failures,0);assert.ok(status.runtime.rolling.p95Ms<2500);
});

test('elevated Shaygan latency opens breaker and blocks further calls without retry storm',async()=>{
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-SLOW',testOptions({ownerId:'slow',minimumSamples:5,maxSourceP95Ms:2500}));await g.acquire();await g.preflight();
  for(let i=0;i<5;i++){await g.beforeCall();await g.afterCall({success:true,durationMs:3000});}
  assert.equal(g.breakerState,'open');await assert.rejects(g.beforeCall(),error=>error.code==='OPENING_BREAKER_OPEN');
  const status=await governorModule.runtimeStatus(db,'OACD-SLOW');assert.equal(status.runtime.pauseReason,'OPENING_SOURCE_LATENCY');assert.ok(status.runtime.nextEligibleResume);
});

test('HTTP failure burst opens breaker after two failures and preserves evidence',async()=>{
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-FAIL',testOptions({ownerId:'failure'}));await g.acquire();await g.preflight();
  await g.beforeCall();await g.afterCall({success:false,durationMs:50,statusCode:503,error:'HTTP 503'});await g.beforeCall();await g.afterCall({success:false,durationMs:60,statusCode:503,error:'HTTP 503'});
  assert.equal(g.breakerState,'open');const status=await governorModule.runtimeStatus(db,'OACD-FAIL');assert.equal(status.runtime.rolling.failures,2);assert.equal(status.runtime.pauseReason,'OPENING_SOURCE_CONSECUTIVE_FAILURES');
});

test('cooldown fails closed and controlled half-open needs its bounded healthy probes',async()=>{
  let now=new Date('2026-08-31T01:00:00Z');const db=dbSeed(),first=governorModule.createGovernor(db,'OACD-HALF',testOptions({ownerId:'first',now:()=>now,cooldownMs:30000,halfOpenCalls:2}));await first.acquire();await first.preflight();await first.beforeCall();await first.afterCall({success:false,durationMs:10,error:'HTTP 503'});await first.beforeCall();await first.afterCall({success:false,durationMs:10,error:'HTTP 503'});await first.release();
  const early=governorModule.createGovernor(db,'OACD-HALF',testOptions({ownerId:'early',now:()=>now,cooldownMs:30000,halfOpenCalls:2}));await early.acquire();await assert.rejects(early.preflight(),error=>error.code==='OPENING_BREAKER_COOLDOWN');await early.release();
  now=new Date(now.getTime()+30001);const probe=governorModule.createGovernor(db,'OACD-HALF',testOptions({ownerId:'probe',now:()=>now,cooldownMs:30000,halfOpenCalls:2}));await probe.acquire();await probe.preflight();assert.equal(probe.breakerState,'half-open');await probe.beforeCall();await probe.afterCall({success:true,durationMs:10});assert.equal(probe.breakerState,'half-open');await probe.beforeCall();await probe.afterCall({success:true,durationMs:10});assert.equal(probe.breakerState,'closed');
});

test('Opening yields while AutoSync is running and never calls Shaygan',async()=>{
  const db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:true,lastStartedAt:new Date()}}]});let calls=0;
  const result=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'}],stockNumbers:['01']},{...testOptions(),shaygan:{getKardexByItemCode:async()=>{calls++;return{ok:true};}}});
  assert.equal(result.status,'paused');assert.equal(result.pauseReason,'OPENING_YIELD_AUTOSYNC_RUNNING');assert.equal(calls,0);assert.equal(db.collection(opening.COLLECTION).rows.length,0);
});

test('Opening yields immediately when AutoSync starts between source calls',async()=>{
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-AUTOSYNC-OVERLAP',testOptions({ownerId:'overlap'}));await g.acquire();await g.preflight();await g.beforeCall();await g.afterCall({success:true,durationMs:100});
  await db.collection('settings').updateOne({key:'inventory.autoSyncStatus'},{$set:{value:{running:true,lastStartedAt:new Date()}}});
  await assert.rejects(g.beforeCall(),error=>error.code==='OPENING_YIELD_AUTOSYNC_RUNNING');const status=await governorModule.runtimeStatus(db,'OACD-AUTOSYNC-OVERLAP');assert.equal(status.runtime.pauseReason,'OPENING_YIELD_AUTOSYNC_RUNNING');assert.equal(status.runtime.rolling.calls,1);
});

test('integrated failure breaker stops Opening before another warehouse request',async()=>{
  const db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:''}},{key:'inventory.activeWarehouseNumbers',value:['01','02','03']}]}),calls=[];
  const api={getKardexByItemCode:async(code,stock,opts)=>{await opts.beforeSourceCall({endpoint:'Item/GetKardex',itemCode:code,stockNumber:stock,rowStart:0});calls.push(`${code}:${stock}`);await opts.afterSourceCall({endpoint:'Item/GetKardex',durationMs:10,success:false,statusCode:503,error:'HTTP 503'});return{ok:false,status:503,error:'HTTP 503',result:[],meta:{}};}};
  const result=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'}]},{...testOptions({maxAttempts:3}),shaygan:api});
  assert.equal(result.status,'paused');assert.equal(result.pauseReason,'OPENING_BREAKER_OPEN');assert.deepEqual(calls,['A:01','A:01']);
});

test('P0/P1 operational traffic never waits on Opening and degraded p95 blocks P3',async()=>{
  traffic._reset();for(let i=0;i<3;i++)traffic.observe('/api/items/search',2000,200,new Date());
  const snapshot=traffic.snapshot();assert.equal(snapshot.classes.P1_SEARCH.count,3);assert.equal(snapshot.classes.P1_SEARCH.p95Ms,2000);
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-OPS',testOptions({ownerId:'ops',operationalHealthProbe:()=>snapshot,maxOperationalP95Ms:1500}));await g.acquire();
  await assert.rejects(g.preflight(),error=>error.code==='OPENING_YIELD_OPERATIONAL_SLA');
  assert.equal(traffic.trafficClass('/api/sales/issue'),'P0_INVOICE');assert.equal(traffic.trafficClass('/api/inventory/search'),'P1_INVENTORY');
});

test('small batch pauses and same dataset resumes only remaining item without duplicate evidence',async()=>{
  const db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:''}},{key:'inventory.activeWarehouseNumbers',value:['01']}]}),calls=[];
  const api={getKardexByItemCode:async(code,stock)=>{calls.push(`${code}:${stock}`);return{ok:true,item:{itemGuid:`G-${code}`,itemCode:code},openingBasis:{openingQuantity:1,openingTotalValue:100,sourceFields:{}},rows:[{date:'2026-03-30'}],meta:{reachedLimit:false}};}};
  const first=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'},{itemGuid:'G-B',itemCode:'B'}]},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:api});
  assert.equal(first.status,'paused');assert.equal(first.pendingItems,1);assert.deepEqual(calls,['A:01']);assert.equal(db.collection(opening.COLLECTION).rows.length,0);
  const second=await opening.resumeCandidate(db,first.datasetId,{}, {username:'khedmati',role:'accounting'},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:api});
  assert.equal(second.status,'completed');assert.deepEqual(calls,['A:01','B:01']);assert.equal(db.collection(opening.COLLECTION).rows.length,2);assert.equal(new Set(db.collection(opening.COLLECTION).rows.map(row=>row.canonicalIdentity)).size,2);
});

test('GetKardex invokes governor hooks for every authoritative page including terminal page',async()=>{
  const prior=global.fetch,calls=[],hooks=[];global.fetch=async(url)=>{const rowStart=Number(new URL(url).searchParams.get('RowStart'));calls.push(rowStart);return{ok:true,status:200,json:async()=>({Result:rowStart===0?[{ItemCode:'A',ItemKardex:[]}]:[]})};};
  try{const result=await shaygan.getKardexByItemCode('A','01',{maxRows:2,hardMaxRows:2,timeoutMs:1000,beforeSourceCall:context=>hooks.push(`before:${context.rowStart}`),afterSourceCall:context=>hooks.push(`after:${context.rowStart}:${context.success}`)});assert.equal(result.ok,true);assert.deepEqual(calls,[0,1]);assert.deepEqual(hooks,['before:0','after:0:true','before:1','after:1:true']);}finally{global.fetch=prior;}
});

test('runtime endpoint contract is read-only and financial collections remain untouched',async()=>{
  const db=dbSeed({supplierPurchaseLayers:[{id:'P'}],fifoAllocations:[{id:'F'}],manualCostResolutions:[]}),g=governorModule.createGovernor(db,'OACD-SAFE',testOptions({ownerId:'safe'}));await g.acquire();await g.preflight();await g.release('paused','test');const status=await governorModule.runtimeStatus(db,'OACD-SAFE');assert.equal(status.readOnly,true);assert.equal(db.collection('supplierPurchaseLayers').rows.length,1);assert.equal(db.collection('fifoAllocations').rows.length,1);assert.equal(db.collection('manualCostResolutions').rows.length,0);
});

test('safety-critical Governor indexes bootstrap independently',async()=>{const db=dbSeed();const names=await governorModule.ensureIndexes(db);assert.ok(names.includes('opening_extraction_scope_unique'));const leaseIndex=(await db.collection(governorModule.LEASES).indexes()).find(row=>row.name==='opening_extraction_scope_unique');assert.equal(leaseIndex.unique,true);});
