'use strict';

const crypto=require('crypto');

const COLLECTION='operationalTrafficObservations';
const MAX_SAMPLES_PER_CLASS=500;
const DEFAULT_WINDOW_MS=5*60*1000;
const DEFAULT_RETENTION_MS=7*24*60*60*1000;
const ROUTE_CLASSES=Object.freeze(['P0_INVOICE_WRITE','P0_INVOICE_RESOLUTION','P0_INVOICE_READ','P1_SEARCH','P1_INVENTORY','P1_KARDEX']);
const FAST_LATENCY_CLASSES=Object.freeze(new Set(['P0_INVOICE_READ','P1_SEARCH','P1_INVENTORY','P1_KARDEX']));
const OBSERVABLE_LATENCY_CLASSES=Object.freeze(new Set(['P0_INVOICE_WRITE','P0_INVOICE_RESOLUTION']));
const COMPONENT_KEYS=Object.freeze(new Set(['prePutMs','putMs','resolveMs','postProcessingMs','totalBeforeResponseMs']));
const samples=new Map();

function clean(value,max=200){return String(value==null?'':value).trim().slice(0,max);}
function safeMethod(method=''){return clean(method,12).toUpperCase();}
function trafficClass(pathname='',method=''){
  const path=clean(pathname,300),verb=safeMethod(method);
  if(verb==='POST'&&(path==='/api/sales/issue'||path==='/admin/accounting/putInvoice'))return 'P0_INVOICE_WRITE';
  if(verb==='POST'&&/^\/api\/sales\/issuance\/[^/]+\/(?:retry-resolution|manual-reconciliation|release)$/.test(path))return 'P0_INVOICE_RESOLUTION';
  if(verb==='GET'&&(path==='/api/sales/issuance/active'||/^\/api\/sales\/issuance\/[^/]+$/.test(path)))return 'P0_INVOICE_READ';
  if(/^\/api\/(?:items\/search|inventory\/search|legacy\/(?:productName|stock)\/search)/.test(path))return path.includes('inventory')||path.includes('/stock/')?'P1_INVENTORY':'P1_SEARCH';
  if(/^\/api\/(?:cardex|item\/cardex|items\/[^/]+\/cardex)/.test(path))return 'P1_KARDEX';
  return '';
}

function requestId(value=''){const result=clean(value,120).replace(/[^A-Za-z0-9_.:\-]/g,'');return result||`opreq-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;}
function attemptIdFromPath(pathname=''){
  const match=clean(pathname,300).match(/^\/api\/sales\/issuance\/([^/]+)(?:\/|$)/);if(!match||match[1]==='active')return '';
  try{return clean(decodeURIComponent(match[1]),160);}catch{return clean(match[1],160);}
}
function componentTimings(value={}){const result={};for(const [key,raw] of Object.entries(value||{}))if(COMPONENT_KEYS.has(key)&&Number.isFinite(Number(raw))&&Number(raw)>=0)result[key]=Math.round(Number(raw));return result;}
function httpClass(statusCode){const status=Number(statusCode||0);return status>=100&&status<=599?`${Math.floor(status/100)}xx`:'network';}
function buildObservation(pathname,durationMs,statusCode,at=new Date(),meta={}){
  const routeClass=trafficClass(pathname,meta.method);if(!routeClass)return null;
  const timestamp=new Date(at),route=clean(pathname,300),status=Number(statusCode||0),attemptId=clean(meta.attemptId,160)||attemptIdFromPath(route);
  return {observationId:`OPTH-${timestamp.getTime()}-${crypto.randomBytes(5).toString('hex')}`,timestamp,expiresAt:new Date(timestamp.getTime()+Math.max(60*1000,Number(meta.retentionMs||DEFAULT_RETENTION_MS))),routeClass,route,method:safeMethod(meta.method),requestId:requestId(meta.requestId),attemptId,actorUsername:clean(meta.actorUsername,100),totalLatencyMs:Math.max(0,Math.round(Number(durationMs||0))),componentTimings:componentTimings(meta.componentTimings),statusCode:status,resultClass:httpClass(status),success:status>0&&status<500,sanitized:true};
}
function observe(pathname,durationMs,statusCode,at=new Date(),meta={}){
  const row=buildObservation(pathname,durationMs,statusCode,at,meta);if(!row)return null;
  const list=samples.get(row.routeClass)||[];list.push({at:row.timestamp,durationMs:row.totalLatencyMs,statusCode:row.statusCode,requestId:row.requestId,attemptId:row.attemptId});
  if(list.length>MAX_SAMPLES_PER_CLASS)list.splice(0,list.length-MAX_SAMPLES_PER_CLASS);samples.set(row.routeClass,list);return row;
}
async function persist(db,row){if(!db||!row)return false;await db.collection(COLLECTION).insertOne(row);return true;}
async function ensureIndexes(db){return Promise.all([
  db.collection(COLLECTION).createIndex({observationId:1},{unique:true,name:'operational_traffic_observation_unique'}),
  db.collection(COLLECTION).createIndex({expiresAt:1},{expireAfterSeconds:0,name:'operational_traffic_observation_ttl'}),
  db.collection(COLLECTION).createIndex({routeClass:1,timestamp:-1},{name:'operational_traffic_class_timeline'}),
  db.collection(COLLECTION).createIndex({attemptId:1,timestamp:-1},{name:'operational_traffic_attempt_timeline',sparse:true})
]);}

function percentile(values,ratio){if(!values.length)return 0;const ordered=values.slice().sort((a,b)=>a-b);return ordered[Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*ratio)-1))];}
function snapshot(options={}){
  const now=options.now?new Date(options.now):new Date(),windowMs=Math.max(1000,Number(options.windowMs||DEFAULT_WINDOW_MS)),from=now.getTime()-windowMs,classes={};
  for(const key of ROUTE_CLASSES){const current=(samples.get(key)||[]).filter(row=>new Date(row.at).getTime()>=from),durations=current.map(row=>row.durationMs),failures=current.filter(row=>row.statusCode>=500||row.statusCode===0).length;classes[key]={count:current.length,failures,errorRate:current.length?failures/current.length:0,p50Ms:percentile(durations,0.5),p95Ms:percentile(durations,0.95),lastAt:current.at(-1)?.at||null,latencyPolicy:FAST_LATENCY_CLASSES.has(key)?'fast-path-threshold':'observe-only'};}
  return {at:now,windowMs,classes};
}
function reset(){samples.clear();}

module.exports={COLLECTION,ROUTE_CLASSES,FAST_LATENCY_CLASSES,OBSERVABLE_LATENCY_CLASSES,trafficClass,buildObservation,observe,persist,ensureIndexes,snapshot,_reset:reset};
