'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const traffic=require('../src/lib/operational-traffic-health');

test('issuance routes are classified by operation and method without mixed populations',()=>{
  assert.equal(traffic.trafficClass('/api/sales/issue','POST'),'P0_INVOICE_WRITE');
  assert.equal(traffic.trafficClass('/admin/accounting/putInvoice','POST'),'P0_INVOICE_WRITE');
  assert.equal(traffic.trafficClass('/api/sales/issuance/A/retry-resolution','POST'),'P0_INVOICE_RESOLUTION');
  assert.equal(traffic.trafficClass('/api/sales/issuance/A/manual-reconciliation','POST'),'P0_INVOICE_RESOLUTION');
  assert.equal(traffic.trafficClass('/api/sales/issuance/A/release','POST'),'P0_INVOICE_RESOLUTION');
  assert.equal(traffic.trafficClass('/api/sales/issuance/active','GET'),'P0_INVOICE_READ');
  assert.equal(traffic.trafficClass('/api/sales/issuance/A','GET'),'P0_INVOICE_READ');
  assert.equal(traffic.trafficClass('/api/sales/issue','GET'),'');
  assert.equal(traffic.trafficClass('/api/sales/issuance/A/release','GET'),'');
  assert.equal(traffic.buildObservation('/api/sales/issuance/active',25,200,new Date(),{method:'GET',requestId:'active-read'}).attemptId,'');
});

test('sanitized observation contains bounded audit fields and no query/body/secrets',()=>{
  const row=traffic.buildObservation('/api/sales/issue',10761,200,new Date('2026-09-01T00:00:00Z'),{method:'POST',requestId:'req 123/$secret',attemptId:'sale:attempt-1',actorUsername:'seller',componentTimings:{prePutMs:5708,putMs:1825,resolveMs:3206,secret:'must-not-persist'},retentionMs:60000,body:{password:'forbidden'}});
  assert.deepEqual({routeClass:row.routeClass,route:row.route,method:row.method,requestId:row.requestId,attemptId:row.attemptId,totalLatencyMs:row.totalLatencyMs,statusCode:row.statusCode,resultClass:row.resultClass},{routeClass:'P0_INVOICE_WRITE',route:'/api/sales/issue',method:'POST',requestId:'req123secret',attemptId:'sale:attempt-1',totalLatencyMs:10761,statusCode:200,resultClass:'2xx'});
  assert.deepEqual(row.componentTimings,{prePutMs:5708,putMs:1825,resolveMs:3206});
  assert.equal(JSON.stringify(row).includes('password'),false);assert.equal(row.expiresAt.toISOString(),'2026-09-01T00:01:00.000Z');
});

test('telemetry persistence is TTL bounded and indexed by class and attempt',async()=>{
  const db=new MemoryDb(),row=traffic.buildObservation('/api/sales/issuance/A',75,200,new Date(),{method:'GET',requestId:'r1'});
  await traffic.ensureIndexes(db);await traffic.persist(db,row);
  assert.equal(db.collection(traffic.COLLECTION).rows.length,1);
  const indexes=await db.collection(traffic.COLLECTION).indexes();
  assert.ok(indexes.some(index=>index.name==='operational_traffic_observation_ttl'&&index.expireAfterSeconds===0));
  assert.ok(indexes.some(index=>index.name==='operational_traffic_class_timeline'));
});

test('in-memory telemetry remains bounded per independent route class',()=>{
  traffic._reset();for(let i=0;i<510;i++)traffic.observe('/api/sales/issue',10000+i,200,new Date(),{method:'POST',requestId:`w${i}`});
  for(let i=0;i<3;i++)traffic.observe('/api/sales/issuance/active',100,200,new Date(),{method:'GET',requestId:`r${i}`});
  const snapshot=traffic.snapshot();assert.equal(snapshot.classes.P0_INVOICE_WRITE.count,500);assert.equal(snapshot.classes.P0_INVOICE_READ.count,3);
});
