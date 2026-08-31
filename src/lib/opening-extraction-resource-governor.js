'use strict';

const crypto=require('crypto');
const os=require('os');

const LEASES='openingAccountingExtractionLeases';
const RUNTIME='openingAccountingExtractionRuntime';
const EVENTS='openingAccountingExtractionEvents';
const SCOPE_KEY='opening-accounting-extraction';

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function clamp(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function percentile(values,ratio){if(!values.length)return 0;const ordered=values.slice().sort((a,b)=>a-b);return ordered[Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*ratio)-1))];}
function pauseError(code,message,statusCode=409){return Object.assign(new Error(message),{code,statusCode,openingPaused:true});}
function ownerIdentity(datasetId,provided=''){return clean(provided,200)||`${os.hostname()}:${process.pid}:${datasetId}:${crypto.randomBytes(6).toString('hex')}`;}

function governedConfig(input={}){
  const testMode=input.testMode===true;
  return Object.freeze({
    maxConcurrency:1,
    minimumDelayMs:clamp(input.minimumDelayMs,testMode?0:1000,60000,testMode?0:3000),
    callsPerMinute:clamp(input.callsPerMinute,1,testMode?60000:30,testMode?60000:20),
    batchSize:clamp(input.batchSize,1,5,1),
    maxBatchesPerRun:clamp(input.maxBatchesPerRun,1,10,1),
    leaseMs:clamp(input.leaseMs,30000,10*60*1000,120000),
    cooldownMs:clamp(input.cooldownMs,30000,60*60*1000,5*60*1000),
    rollingWindowCalls:clamp(input.rollingWindowCalls,5,50,10),
    minimumSamples:clamp(input.minimumSamples,3,20,5),
    maxErrorRate:clamp(input.maxErrorRate,0.05,0.5,0.2),
    maxConsecutiveFailures:clamp(input.maxConsecutiveFailures,1,5,2),
    maxSourceP95Ms:clamp(input.maxSourceP95Ms,500,30000,2500),
    maxOperationalP95Ms:clamp(input.maxOperationalP95Ms,250,10000,1500),
    halfOpenCalls:clamp(input.halfOpenCalls,1,3,2),
    allowedStartHour:Number.isInteger(Number(input.allowedStartHour))?clamp(input.allowedStartHour,0,23,0):null,
    allowedEndHour:Number.isInteger(Number(input.allowedEndHour))?clamp(input.allowedEndHour,0,23,23):null
  });
}

class OpeningResourceGovernor{
  constructor(db,datasetId,options={}){
    this.db=db;this.datasetId=clean(datasetId,100);this.config=governedConfig(options);this.ownerId=ownerIdentity(this.datasetId,options.ownerId);this.now=typeof options.now==='function'?options.now:()=>new Date();this.sleep=typeof options.sleep==='function'?options.sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms));this.operationalHealthProbe=options.operationalHealthProbe;this.calls=[];this.lastCallAt=0;this.consecutiveFailures=0;this.breakerState='closed';this.nextEligibleResume=null;this.halfOpenRemaining=this.config.halfOpenCalls;this.acquired=false;
  }
  async event(type,detail={}){await this.db.collection(EVENTS).insertOne({eventId:`OEG-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,scopeKey:SCOPE_KEY,datasetId:this.datasetId,ownerId:this.ownerId,type,detail,at:this.now(),immutable:true}).catch(()=>{});}
  async acquire(){
    const now=this.now(),expiresAt=new Date(now.getTime()+this.config.leaseMs),collection=this.db.collection(LEASES);
    const result=await collection.updateOne({scopeKey:SCOPE_KEY,$or:[{expiresAt:{$lte:now}},{ownerId:this.ownerId}]},{$set:{scopeKey:SCOPE_KEY,ownerId:this.ownerId,datasetId:this.datasetId,pid:process.pid,processIdentity:`${os.hostname()}:${process.pid}`,acquiredAt:now,heartbeatAt:now,expiresAt,state:'owned',updatedAt:now}});
    if(!result.matchedCount){
      const existing=await collection.findOne({scopeKey:SCOPE_KEY});
      if(!existing){try{await collection.insertOne({scopeKey:SCOPE_KEY,ownerId:this.ownerId,datasetId:this.datasetId,pid:process.pid,processIdentity:`${os.hostname()}:${process.pid}`,acquiredAt:now,heartbeatAt:now,expiresAt,state:'owned',updatedAt:now});}catch{}}
    }
    const lease=await collection.findOne({scopeKey:SCOPE_KEY});
    if(!lease||lease.ownerId!==this.ownerId)throw pauseError('OPENING_EXTRACTION_LEASE_HELD',`Opening extraction is owned by ${clean(lease?.ownerId,200)||'another worker'}`);
    this.acquired=true;await this.event('LEASE_ACQUIRED',{expiresAt});return lease;
  }
  async heartbeat(){
    if(!this.acquired)throw pauseError('OPENING_EXTRACTION_LEASE_NOT_OWNED','Opening extraction lease is not owned.');
    const now=this.now(),expiresAt=new Date(now.getTime()+this.config.leaseMs),result=await this.db.collection(LEASES).updateOne({scopeKey:SCOPE_KEY,ownerId:this.ownerId,datasetId:this.datasetId},{$set:{heartbeatAt:now,expiresAt,updatedAt:now}});
    if(!result.matchedCount)throw pauseError('OPENING_EXTRACTION_LEASE_LOST','Opening extraction lease was lost.');
  }
  async release(state='paused',reason=''){
    if(!this.acquired)return;const now=this.now();
    await this.db.collection(LEASES).updateOne({scopeKey:SCOPE_KEY,ownerId:this.ownerId,datasetId:this.datasetId},{$set:{state,releaseReason:clean(reason,200),releasedAt:now,expiresAt:now,heartbeatAt:now,updatedAt:now},$unset:{ownerId:'',pid:'',processIdentity:''}});
    this.acquired=false;await this.persist({state,pauseReason:clean(reason,200)});await this.event('LEASE_RELEASED',{state,reason:clean(reason,200)});
  }
  withinWindow(now){if(this.config.allowedStartHour==null||this.config.allowedEndHour==null)return true;const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tehran',hour:'2-digit',hourCycle:'h23'}).format(now));const start=this.config.allowedStartHour,end=this.config.allowedEndHour;return start<=end?(hour>=start&&hour<end):(hour>=start||hour<end);}
  async health(){
    const now=this.now();if(!this.withinWindow(now))return {ok:false,code:'OPENING_OUTSIDE_ALLOWED_WINDOW'};
    const auto=await this.db.collection('settings').findOne({key:'inventory.autoSyncStatus'}).catch(()=>null),value=auto?.value||{};
    if(value.running===true)return {ok:false,code:'OPENING_YIELD_AUTOSYNC_RUNNING',autoSync:{running:true,lastStartedAt:value.lastStartedAt||null,currentStockNumber:value.currentStockNumber||''}};
    const last=value.lastCycle||value.lastResult||{};
    if(clean(value.lastError,500)||Number(last.timeouts||last.exactTimeouts||0)>0)return {ok:false,code:'OPENING_YIELD_AUTOSYNC_UNHEALTHY',autoSync:{running:false,lastError:clean(value.lastError,500),timeouts:Number(last.timeouts||last.exactTimeouts||0)}};
    const operational=typeof this.operationalHealthProbe==='function'?await this.operationalHealthProbe():null;
    if(operational?.classes){for(const [trafficClass,metric] of Object.entries(operational.classes)){if(Number(metric.count||0)>=3&&(Number(metric.p95Ms||0)>this.config.maxOperationalP95Ms||Number(metric.errorRate||0)>0.1))return {ok:false,code:'OPENING_YIELD_OPERATIONAL_SLA',trafficClass,metric};}}
    return {ok:true,autoSync:{running:false,lastRunAt:value.lastRunAt||value.updatedAt||null},operational};
  }
  async preflight(){
    const runtime=await this.db.collection(RUNTIME).findOne({datasetId:this.datasetId}),now=this.now();
    if(runtime?.breakerState==='open'){this.breakerState='open';this.nextEligibleResume=runtime.nextEligibleResume?new Date(runtime.nextEligibleResume):null;}
    if(this.breakerState==='open'&&new Date(this.nextEligibleResume||0)>now)throw pauseError('OPENING_BREAKER_COOLDOWN',`Opening extraction cooldown is active until ${new Date(this.nextEligibleResume).toISOString()}`);
    if(this.breakerState==='open'){this.breakerState='half-open';this.halfOpenRemaining=this.config.halfOpenCalls;}
    const health=await this.health();if(!health.ok){await this.openBreaker(health.code,health);throw pauseError(health.code,'Opening extraction yielded to operational traffic.');}
    await this.persist({state:'running',pauseReason:'',health});return health;
  }
  rolling(){const rows=this.calls.slice(-this.config.rollingWindowCalls),durations=rows.map(row=>row.durationMs),failures=rows.filter(row=>!row.success).length;return {sampleCount:rows.length,calls:this.calls.length,successes:this.calls.filter(row=>row.success).length,failures:this.calls.filter(row=>!row.success).length,errorRate:rows.length?failures/rows.length:0,p50Ms:percentile(durations,0.5),p95Ms:percentile(durations,0.95),lastSuccessfulCall:this.calls.filter(row=>row.success).at(-1)?.completedAt||null,lastFailure:this.calls.filter(row=>!row.success).at(-1)||null};}
  async persist(extra={}){const now=this.now(),rolling=this.rolling();await this.db.collection(RUNTIME).updateOne({datasetId:this.datasetId},{$set:{datasetId:this.datasetId,scopeKey:SCOPE_KEY,workerOwner:this.ownerId,leaseState:this.acquired?'owned':'released',breakerState:this.breakerState,nextEligibleResume:this.nextEligibleResume,config:this.config,rolling,...extra,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});}
  async openBreaker(reason,evidence={}){if(this.breakerState==='open')return;this.breakerState='open';this.nextEligibleResume=new Date(this.now().getTime()+this.config.cooldownMs);await this.persist({state:'paused',pauseReason:clean(reason,200),breakerEvidence:evidence});await this.event('BREAKER_OPENED',{reason:clean(reason,200),nextEligibleResume:this.nextEligibleResume,evidence});}
  async beforeCall(context={}){
    await this.heartbeat();
    if(this.breakerState==='open')throw pauseError('OPENING_BREAKER_OPEN','Opening extraction circuit breaker is open.');
    const health=await this.health();if(!health.ok){await this.openBreaker(health.code,health);throw pauseError(health.code,'Opening extraction yielded to operational traffic.');}
    if(this.breakerState==='half-open'&&this.halfOpenRemaining<=0)throw pauseError('OPENING_HALF_OPEN_LIMIT','Opening half-open probe limit reached.');
    const interval=Math.max(this.config.minimumDelayMs,Math.ceil(60000/this.config.callsPerMinute)),wait=Math.max(0,this.lastCallAt+interval-Date.now());if(wait)await this.sleep(wait);
    await this.heartbeat();this.lastCallAt=Date.now();return {startedAt:this.now(),context};
  }
  async afterCall(observation={}){
    const completedAt=this.now(),row={completedAt,durationMs:Math.max(0,Number(observation.durationMs||0)),success:observation.success===true,statusCode:Number(observation.statusCode||0),error:clean(observation.error,500),endpoint:clean(observation.endpoint||'Item/GetKardex',100)};this.calls.push(row);this.consecutiveFailures=row.success?0:this.consecutiveFailures+1;if(this.breakerState==='half-open')this.halfOpenRemaining--;
    const rolling=this.rolling();await this.persist({state:'running',lastCall:row});
    if(this.consecutiveFailures>=this.config.maxConsecutiveFailures){await this.openBreaker('OPENING_SOURCE_CONSECUTIVE_FAILURES',{consecutiveFailures:this.consecutiveFailures,rolling});return;}
    if(rolling.sampleCount>=this.config.minimumSamples&&rolling.errorRate>=this.config.maxErrorRate){await this.openBreaker('OPENING_SOURCE_ERROR_RATE',{rolling});return;}
    if(rolling.sampleCount>=this.config.minimumSamples&&rolling.p95Ms>=this.config.maxSourceP95Ms){await this.openBreaker('OPENING_SOURCE_LATENCY',{rolling});return;}
    if(this.breakerState==='half-open'&&row.success&&this.halfOpenRemaining<=0){this.breakerState='closed';this.nextEligibleResume=null;await this.persist({state:'running',pauseReason:'',breakerEvidence:null});await this.event('BREAKER_CLOSED',{reason:'healthy-half-open-probe'});}
  }
  async batchCheckpoint(detail={}){await this.heartbeat();await this.persist({state:'running',batchProgress:detail});await this.event('BATCH_CHECKPOINT',detail);}
}

async function runtimeStatus(db,datasetId=''){const query=clean(datasetId,100)?{datasetId:clean(datasetId,100)}:{};const runtime=await db.collection(RUNTIME).findOne(query,{sort:{updatedAt:-1}}),lease=await db.collection(LEASES).findOne({scopeKey:SCOPE_KEY});return {ok:true,readOnly:true,runtime,lease};}
function createGovernor(db,datasetId,options={}){return new OpeningResourceGovernor(db,datasetId,options);}

module.exports={LEASES,RUNTIME,EVENTS,SCOPE_KEY,governedConfig,createGovernor,runtimeStatus,OpeningResourceGovernor,_pauseError:pauseError};
