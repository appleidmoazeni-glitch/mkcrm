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
function healthyAutoSync(startedAt=new Date(),overrides={}){return {running:false,lastStartedAt:startedAt,lastRunAt:new Date(new Date(startedAt).getTime()+1000),lastError:'',lastResult:{ok:true,stockCompleted:19,timeouts:0,exactTimeouts:0,durationMs:1000},...overrides};}
async function setAutoSync(db,value){await db.collection('settings').updateOne({key:'inventory.autoSyncStatus'},{$set:{value}});}

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

test('Opening cooperatively waits for a healthy AutoSync before its first Shaygan call',async()=>{
  const startedAt=new Date(),db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:true,lastStartedAt:startedAt}}]});let calls=0;
  const sleep=async()=>{const row=await db.collection('settings').findOne({key:'inventory.autoSyncStatus'});if(row.value.running)await setAutoSync(db,healthyAutoSync(startedAt));};
  const result=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'}],stockNumbers:['01']},{...testOptions({sleep}),shaygan:{getKardexByItemCode:async()=>{calls++;return{ok:true,item:{itemGuid:'G-A',itemCode:'A'},openingBasis:null,rows:[],meta:{reachedLimit:false}};}}});
  assert.equal(result.status,'completed');assert.equal(calls,1);const events=db.collection(governorModule.EVENTS).rows.map(row=>row.type);assert.ok(events.includes('COOPERATIVE_YIELD_STARTED'));assert.ok(events.includes('COOPERATIVE_RESUME'));
});

test('Opening cooperatively yields when AutoSync starts between source calls and keeps its lease',async()=>{
  const db=dbSeed(),startedAt=new Date(),sleep=async()=>{const row=await db.collection('settings').findOne({key:'inventory.autoSyncStatus'});if(row.value.running)await setAutoSync(db,healthyAutoSync(startedAt));},g=governorModule.createGovernor(db,'OACD-AUTOSYNC-OVERLAP',testOptions({ownerId:'overlap',sleep}));await g.acquire();await g.preflight();await g.beforeCall();await g.afterCall({success:true,durationMs:100});
  await setAutoSync(db,{running:true,lastStartedAt:startedAt});await g.beforeCall();const status=await governorModule.runtimeStatus(db,'OACD-AUTOSYNC-OVERLAP');assert.equal(status.runtime.breakerState,'closed');assert.equal(status.runtime.state,'running');assert.equal(status.lease.ownerId,'overlap');assert.equal(status.runtime.rolling.calls,1);
});

test('completed warehouse checkpoints survive a healthy AutoSync overlap and resume at warehouse 03',async()=>{
  const startedAt=new Date(),db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:''}},{key:'inventory.activeWarehouseNumbers',value:['01','02','03']}]}),calls=[];
  const sleep=async()=>{const row=await db.collection('settings').findOne({key:'inventory.autoSyncStatus'});if(row.value.running)await setAutoSync(db,healthyAutoSync(startedAt));};
  const api={getKardexByItemCode:async(code,stock,opts)=>{await opts.beforeSourceCall({itemCode:code,stockNumber:stock});calls.push(`${code}:${stock}`);await opts.afterSourceCall({success:true,durationMs:10});if(stock==='02')await setAutoSync(db,{running:true,lastStartedAt:startedAt});return{ok:true,item:{itemGuid:'G-A',itemCode:'A'},openingBasis:null,rows:[],meta:{reachedLimit:false}};}};
  const result=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'}]},{...testOptions({sleep}),shaygan:api});
  assert.equal(result.status,'completed');assert.deepEqual(calls,['A:01','A:02','A:03']);const progress=db.collection(opening.PROGRESS).rows[0];assert.deepEqual(progress.warehouseStates.map(row=>row.attemptCount),[1,1,1]);assert.equal(progress.status,'NO_OPENING_STOCK');
});

test('repeated healthy AutoSync overlaps remain cooperative under the same lease',async()=>{
  const firstStart=new Date(),secondStart=new Date(firstStart.getTime()+2000),db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:true,lastStartedAt:firstStart}}]});let phase=0;
  const sleep=async()=>{const row=await db.collection('settings').findOne({key:'inventory.autoSyncStatus'});if(phase===0&&row.value.running){phase=1;await setAutoSync(db,healthyAutoSync(firstStart));}else if(phase===1&&!row.value.running){phase=2;await setAutoSync(db,{running:true,lastStartedAt:secondStart});}else if(phase===2&&row.value.running){phase=3;await setAutoSync(db,healthyAutoSync(secondStart));}};
  const g=governorModule.createGovernor(db,'OACD-REPEATED',testOptions({ownerId:'same-worker',sleep}));await g.acquire();await g.preflight();const status=await governorModule.runtimeStatus(db,'OACD-REPEATED');assert.equal(status.runtime.breakerState,'closed');assert.equal(status.lease.ownerId,'same-worker');assert.equal(status.runtime.cooperativeYield.yieldCount,2);assert.equal(db.collection(governorModule.EVENTS).rows.filter(row=>row.type==='COOPERATIVE_YIELD_REENTERED').length,1);
});

test('unhealthy AutoSync completion converts cooperative yield to the safety breaker',async()=>{
  const startedAt=new Date(),db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:true,lastStartedAt:startedAt}}]});const sleep=async()=>setAutoSync(db,healthyAutoSync(startedAt,{lastError:'warehouse timeout',lastResult:{ok:false,stockCompleted:18,timeouts:1}}));
  const g=governorModule.createGovernor(db,'OACD-AUTOSYNC-UNHEALTHY',testOptions({ownerId:'unhealthy',sleep}));await g.acquire();await assert.rejects(g.preflight(),error=>error.code==='OPENING_YIELD_AUTOSYNC_UNHEALTHY');const status=await governorModule.runtimeStatus(db,'OACD-AUTOSYNC-UNHEALTHY');assert.equal(status.runtime.breakerState,'open');assert.ok(status.runtime.nextEligibleResume);
});

test('operational SLA degradation after healthy AutoSync opens the safety breaker before resume',async()=>{
  const startedAt=new Date(),db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:true,lastStartedAt:startedAt}}]}),healthy={classes:{P1_SEARCH:{count:3,p95Ms:100,errorRate:0}}},degraded={classes:{P1_SEARCH:{count:3,p95Ms:2000,errorRate:0}}};let probe=healthy;
  const sleep=async()=>{const row=await db.collection('settings').findOne({key:'inventory.autoSyncStatus'});if(row.value.running)await setAutoSync(db,healthyAutoSync(startedAt));else probe=degraded;};
  const g=governorModule.createGovernor(db,'OACD-AUTOSYNC-SLA',testOptions({ownerId:'sla',sleep,operationalHealthProbe:()=>probe,maxOperationalP95Ms:1500}));await g.acquire();await assert.rejects(g.preflight(),error=>error.code==='OPENING_YIELD_OPERATIONAL_SLA');const status=await governorModule.runtimeStatus(db,'OACD-AUTOSYNC-SLA');assert.equal(status.runtime.breakerState,'open');
});

test('worker crash while cooperatively yielded preserves single-owner lease recovery and in-progress selection',async()=>{
  let now=new Date('2026-08-31T00:00:00Z');const datasetId='OACD-YIELD-CRASH',row={progressId:`${datasetId}:code:A`,datasetId,item:{itemCode:'A'},status:'pending',selectionState:'in_progress',selectionStartedAt:now,firstQueuedAt:now,nextEligibleAt:now,createdAt:now,updatedAt:now},db=dbSeed({[opening.PROGRESS]:[row]});
  const crashed=governorModule.createGovernor(db,datasetId,testOptions({ownerId:'crashed-worker',now:()=>now,leaseMs:30000}));await crashed.acquire();await crashed.persist({state:'YIELDED_AUTOSYNC',cooperativeYield:{status:'waiting'}});
  const replacement=governorModule.createGovernor(db,datasetId,testOptions({ownerId:'replacement',now:()=>now,leaseMs:30000}));await assert.rejects(replacement.acquire(),error=>error.code==='OPENING_EXTRACTION_LEASE_HELD');now=new Date(now.getTime()+30001);await replacement.acquire();const selected=await opening._selectResumeProgress(db,datasetId,{},1,now);assert.equal(selected[0].progressId,row.progressId);assert.equal(selected[0].selectionState,'in_progress');
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
  assert.equal(traffic.trafficClass('/api/sales/issue','POST'),'P0_INVOICE_WRITE');assert.equal(traffic.trafficClass('/api/inventory/search','GET'),'P1_INVENTORY');
});

test('invoice write and resolution latency are observable without inheriting the fast-read 1500ms breaker',async()=>{
  traffic._reset();
  for(const latency of [10000,10761,12000])traffic.observe('/api/sales/issue',latency,200,new Date(),{method:'POST'});
  for(let i=0;i<3;i++)traffic.observe('/api/sales/issuance/active',100,200,new Date(),{method:'GET'});
  for(let i=0;i<3;i++)traffic.observe('/api/items/search',120,200,new Date(),{method:'GET'});
  const snapshot=traffic.snapshot();
  assert.equal(snapshot.classes.P0_INVOICE_WRITE.p95Ms,12000);assert.equal(snapshot.classes.P0_INVOICE_WRITE.latencyPolicy,'observe-only');
  assert.equal(snapshot.classes.P0_INVOICE_READ.p95Ms,100);assert.equal(snapshot.classes.P0_INVOICE_READ.latencyPolicy,'fast-path-threshold');
  const db=dbSeed(),g=governorModule.createGovernor(db,'OACD-INVOICE-BASELINE',testOptions({ownerId:'invoice-baseline',operationalHealthProbe:()=>snapshot,maxOperationalP95Ms:1500}));await g.acquire();const health=await g.preflight();assert.equal(health.ok,true);
});

test('invoice 5xx and genuine fast invoice-read degradation still stop Opening',async()=>{
  const failure=governorModule.operationalSafetyBreach({P0_INVOICE_WRITE:{count:1,failures:1,errorRate:1,p95Ms:11000}},1500);
  assert.deepEqual({trafficClass:failure.trafficClass,reason:failure.reason},{trafficClass:'P0_INVOICE_WRITE',reason:'INVOICE_FAILURE'});
  const slowRead=governorModule.operationalSafetyBreach({P0_INVOICE_READ:{count:3,failures:0,errorRate:0,p95Ms:2000}},1500);
  assert.deepEqual({trafficClass:slowRead.trafficClass,reason:slowRead.reason},{trafficClass:'P0_INVOICE_READ',reason:'FAST_PATH_LATENCY'});
});

test('small batch pauses and same dataset resumes only remaining item without duplicate evidence',async()=>{
  const db=dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:''}},{key:'inventory.activeWarehouseNumbers',value:['01']}]}),calls=[];
  const api={getKardexByItemCode:async(code,stock)=>{calls.push(`${code}:${stock}`);return{ok:true,item:{itemGuid:`G-${code}`,itemCode:code},openingBasis:{openingQuantity:1,openingTotalValue:100,sourceFields:{}},rows:[{date:'2026-03-30'}],meta:{reachedLimit:false}};}};
  const first=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:{username:'khedmati',role:'accounting'},items:[{itemGuid:'G-A',itemCode:'A'},{itemGuid:'G-B',itemCode:'B'}]},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:api});
  assert.equal(first.status,'paused');assert.equal(first.pendingItems,1);assert.deepEqual(calls,['A:01']);assert.equal(db.collection(opening.COLLECTION).rows.length,0);
  const second=await opening.resumeCandidate(db,first.datasetId,{}, {username:'khedmati',role:'accounting'},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:api});
  assert.equal(second.status,'completed');assert.deepEqual(calls,['A:01','B:01']);assert.equal(db.collection(opening.COLLECTION).rows.length,2);assert.equal(new Set(db.collection(opening.COLLECTION).rows.map(row=>row.canonicalIdentity)).size,2);
});

test('equal-timestamp Opening progress has a total stable order and unchanged queries return the same record',async()=>{
  const at=new Date('2026-08-31T00:00:00Z'),datasetId='OACD-ORDER',rows=['C','A','B'].map(code=>({progressId:`${datasetId}:code:${code}`,datasetId,canonicalIdentity:`code:${code}`,item:{itemCode:code},status:'pending',selectionState:'queued',firstQueuedAt:at,nextEligibleAt:at,createdAt:at,updatedAt:at})),db=dbSeed({[opening.PROGRESS]:rows});
  assert.deepEqual(opening._deterministicProgressSort(),{nextEligibleAt:1,firstQueuedAt:1,createdAt:1,progressId:1});
  const first=await opening._selectResumeProgress(db,datasetId,{},1,new Date('2026-08-31T00:01:00Z'));
  const repeated=await opening._selectResumeProgress(db,datasetId,{},1,new Date('2026-08-31T00:01:00Z'));
  assert.equal(first[0].item.itemCode,'A');assert.equal(repeated[0].progressId,first[0].progressId);
  await db.collection(opening.PROGRESS).updateOne({progressId:first[0].progressId},{$set:{status:'VALIDATED_CANDIDATE',selectionState:'completed'}});
  const second=await opening._selectResumeProgress(db,datasetId,{},1,new Date('2026-08-31T00:01:00Z'));assert.equal(second[0].item.itemCode,'B');
});

test('crashed in-progress Opening record is recovered before queued peers despite a newer updatedAt',async()=>{
  const at=new Date('2026-08-31T00:00:00Z'),datasetId='OACD-CRASH',db=dbSeed({[opening.PROGRESS]:[
    {progressId:`${datasetId}:code:A`,datasetId,item:{itemCode:'A'},status:'pending',selectionState:'queued',firstQueuedAt:at,nextEligibleAt:at,createdAt:at,updatedAt:at},
    {progressId:`${datasetId}:code:B`,datasetId,item:{itemCode:'B'},status:'pending',selectionState:'queued',firstQueuedAt:at,nextEligibleAt:at,createdAt:at,updatedAt:at}
  ]});
  const selected=(await opening._selectResumeProgress(db,datasetId,{},1,new Date('2026-08-31T00:01:00Z')))[0];
  await opening._markProgressInFlight(db,selected,'worker-before-crash',new Date('2026-08-31T00:02:00Z'));
  const recovered=await opening._selectResumeProgress(db,datasetId,{},1,new Date('2026-08-31T00:03:00Z'));
  assert.equal(recovered[0].item.itemCode,'A');assert.equal(recovered[0].selectionState,'in_progress');
});

function explicitTargetFixture(targetEligible=true){
  const at=new Date('2026-08-31T00:00:00Z'),datasetId='OACD-TARGET',progress=['A','B','C'].map(code=>({progressId:`${datasetId}:code:${code}`,datasetId,canonicalIdentity:`code:${code}`,item:{itemGuid:`G-${code}`,itemCode:code},openingDate:'14050110',status:'pending',selectionState:'queued',firstQueuedAt:at,nextEligibleAt:code==='C'&&!targetEligible?new Date('2099-01-01T00:00:00Z'):at,warehouseStates:[{warehouseNumber:'01',status:'pending',attemptCount:0,attempts:[]}],sourceCallCount:0,createdAt:at,updatedAt:at}));
  return {datasetId,db:dbSeed({settings:[{key:'inventory.autoSyncStatus',value:{running:false,lastError:''}},{key:'inventory.activeWarehouseNumbers',value:['01']}],[opening.DATASETS]:[{datasetId,status:'paused',approvalStatus:'draft',active:false,openingDate:'14050110',governedWarehouses:['01'],revision:1,createdAt:at,updatedAt:at}],[opening.PROGRESS]:progress})};
}

test('explicit canary target processes only C and never falls back to A or B',async()=>{
  const {db,datasetId}=explicitTargetFixture(),calls=[],api={getKardexByItemCode:async code=>{calls.push(code);return{ok:true,item:{itemGuid:`G-${code}`,itemCode:code},openingBasis:{openingQuantity:1,openingTotalValue:100,sourceFields:{}},rows:[{date:'2026-03-30'}],meta:{reachedLimit:false}};}};
  const result=await opening.resumeCandidate(db,datasetId,{targetItemCode:'C'},{username:'admin',role:'admin'},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:api});
  assert.equal(result.status,'paused');assert.deepEqual(calls,['C']);
  const rows=db.collection(opening.PROGRESS).rows;assert.equal(rows.find(row=>row.item.itemCode==='C').status,'VALIDATED_CANDIDATE');assert.equal(rows.find(row=>row.item.itemCode==='A').status,'pending');assert.equal(rows.find(row=>row.item.itemCode==='B').status,'pending');
});

test('explicit canary target fails closed when target is ineligible and performs no source call or fallback',async()=>{
  const {db,datasetId}=explicitTargetFixture(false);let calls=0;
  await assert.rejects(opening.resumeCandidate(db,datasetId,{targetItemCode:'C'},{username:'admin',role:'admin'},{...testOptions({batchSize:1,maxBatchesPerRun:1}),shaygan:{getKardexByItemCode:async()=>{calls++;return{ok:true};}}}),error=>error.code==='OPENING_RESUME_TARGET_NOT_ELIGIBLE');
  assert.equal(calls,0);assert.equal(db.collection(opening.DATASETS).rows[0].resumeCount,undefined);assert.ok(db.collection(opening.PROGRESS).rows.every(row=>row.status==='pending'));
});

test('explicit Opening target is an Admin-only diagnostic control on the existing Resume endpoint',()=>{
  const fs=require('node:fs'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(source,/hasExplicitOpeningTarget=action==='resume'/);assert.match(source,/hasExplicitOpeningTarget&&!requireRole\(req,res,\['admin'\]\)/);
  assert.doesNotMatch(source,/req\.query\.(?:targetProgressId|targetCanonicalIdentity|targetItemCode)/);
});

test('GetKardex invokes governor hooks for every authoritative page including terminal page',async()=>{
  const prior=global.fetch,calls=[],hooks=[];global.fetch=async(url)=>{const rowStart=Number(new URL(url).searchParams.get('RowStart'));calls.push(rowStart);return{ok:true,status:200,json:async()=>({Result:rowStart===0?[{ItemCode:'A',ItemKardex:[]}]:[]})};};
  try{const result=await shaygan.getKardexByItemCode('A','01',{maxRows:2,hardMaxRows:2,timeoutMs:1000,beforeSourceCall:context=>hooks.push(`before:${context.rowStart}`),afterSourceCall:context=>hooks.push(`after:${context.rowStart}:${context.success}`)});assert.equal(result.ok,true);assert.deepEqual(calls,[0,1]);assert.deepEqual(hooks,['before:0','after:0:true','before:1','after:1:true']);}finally{global.fetch=prior;}
});

test('runtime endpoint contract is read-only and financial collections remain untouched',async()=>{
  const db=dbSeed({supplierPurchaseLayers:[{id:'P'}],fifoAllocations:[{id:'F'}],manualCostResolutions:[]}),g=governorModule.createGovernor(db,'OACD-SAFE',testOptions({ownerId:'safe'}));await g.acquire();await g.preflight();await g.release('paused','test');const status=await governorModule.runtimeStatus(db,'OACD-SAFE');assert.equal(status.readOnly,true);assert.equal(db.collection('supplierPurchaseLayers').rows.length,1);assert.equal(db.collection('fifoAllocations').rows.length,1);assert.equal(db.collection('manualCostResolutions').rows.length,0);
});

test('safety-critical Governor and deterministic Resume indexes bootstrap independently',async()=>{const db=dbSeed();const names=await opening.ensureResourceGovernorIndexes(db);assert.ok(names.includes('opening_extraction_scope_unique'));assert.ok(names.includes('opening_resume_deterministic_selection'));const leaseIndex=(await db.collection(governorModule.LEASES).indexes()).find(row=>row.name==='opening_extraction_scope_unique');assert.equal(leaseIndex.unique,true);const resumeIndex=(await db.collection(opening.PROGRESS).indexes()).find(row=>row.name==='opening_resume_deterministic_selection');assert.deepEqual(resumeIndex.key,{datasetId:1,status:1,selectionState:1,nextEligibleAt:1,firstQueuedAt:1,createdAt:1,progressId:1});});
