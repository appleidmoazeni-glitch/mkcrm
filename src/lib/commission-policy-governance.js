'use strict';

const crypto = require('crypto');
const { canonicalSaleDate } = require('./jalali-date');

const POLICIES = 'commissionPolicyVersions';
const BINDINGS = 'commissionPolicyRecordBindings';
const APPROVAL_LOCKS = 'commissionPolicyApprovalLocks';
const LEGACY_POLICY_ID = 'LEGACY_PRE_POLICY';
const RECORD_COLLECTIONS = Object.freeze({
  category_mapping:'commissionCategoryMappings',
  rate_version:'commissionRateVersions'
});
const READ_ROLES = Object.freeze(['admin', 'accounting', 'manager']);
const EDIT_ROLES = Object.freeze(['admin', 'accounting']);
const APPROVE_ROLES = Object.freeze(['admin', 'manager']);

function clean(value, max = 1000) { return String(value == null ? '' : value).trim().slice(0, max); }
function actor(value = {}) { return { username:clean(value.username || value.user || 'system', 100), role:clean(value.role || 'system', 50) }; }
function fail(code, message, statusCode = 400, details = {}) { const error = new Error(message); error.code=code; error.statusCode=statusCode; Object.assign(error, details); throw error; }
function requireRole(value, allowed) { const current=actor(value); if(!allowed.includes(current.role)) fail('COMMISSION_POLICY_FORBIDDEN','دسترسی به سیاست پورسانت مجاز نیست.',403); return current; }
function stable(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value.toHexString === 'function') return JSON.stringify(value.toHexString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function newId(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; }
function date8(value, field, optional=false) { if(optional&&!clean(value)) return ''; const raw=clean(value).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^0-9]/g,''); if(/^20\d{6}$/.test(raw)) fail('COMMISSION_POLICY_JALALI_DATE_REQUIRED',`${field} باید تاریخ شمسی YYYYMMDD باشد.`); const date=canonicalSaleDate(value,{field}); if(!/^(13|14)\d{6}$/.test(date)) fail('COMMISSION_POLICY_JALALI_DATE_REQUIRED',`${field} باید تاریخ شمسی YYYYMMDD باشد.`); return date; }
function audit(action, by, details={}) { return {action,by:actor(by),at:new Date(),details:JSON.parse(JSON.stringify(details))}; }
function policyContent(row) { return {policyVersionId:row.policyVersionId,name:row.name,accountingPeriod:row.accountingPeriod,effectiveFrom:row.effectiveFrom,effectiveTo:row.effectiveTo||'',description:row.description||'',successorOf:row.successorOf||''}; }
function contentHash(row) { return sha256(stable(policyContent(row))); }
function sourceProjection(row) { const output={}; for(const key of Object.keys(row||{}).sort()) if(key!=='_id') output[key]=row[key]; return output; }
function sourceHash(row) { return sha256(stable(sourceProjection(row))); }

async function ensureIndexes(db) {
  const names=new Set((await db.listCollections().toArray()).map(row=>row.name));
  for(const name of [POLICIES,BINDINGS,APPROVAL_LOCKS]) if(!names.has(name)) await db.createCollection(name).catch(()=>{});
  await db.collection(POLICIES).createIndex({policyVersionId:1},{unique:true});
  await db.collection(POLICIES).createIndex({accountingPeriod:1,status:1,effectiveFrom:1,effectiveTo:1});
  await db.collection(BINDINGS).createIndex({recordType:1,recordId:1},{unique:true});
  await db.collection(BINDINGS).createIndex({policyVersionId:1,recordType:1});
  await db.collection(APPROVAL_LOCKS).createIndex({lockKey:1},{unique:true});
  return {ok:true};
}
function validatePolicy(input={}, existing={}) {
  const accountingPeriod=clean(input.accountingPeriod??existing.accountingPeriod,6);
  if(!/^\d{6}$/.test(accountingPeriod)) fail('COMMISSION_POLICY_PERIOD_INVALID','دوره حسابداری باید شش رقم شمسی YYYYMM باشد.');
  const effectiveFrom=date8(input.effectiveFrom??existing.effectiveFrom,'effectiveFrom');
  const effectiveTo=date8(input.effectiveTo??existing.effectiveTo,'effectiveTo',true);
  if(effectiveTo&&effectiveTo<effectiveFrom) fail('COMMISSION_POLICY_RANGE_INVALID','بازه اثر سیاست معکوس است.');
  const name=clean(input.name??existing.name,300); if(!name) fail('COMMISSION_POLICY_NAME_REQUIRED','نام سیاست الزامی است.');
  return {name,accountingPeriod,effectiveFrom,effectiveTo,description:clean(input.description??existing.description,2000),successorOf:clean(input.successorOf??existing.successorOf,100)};
}
function overlaps(a,b){return a.effectiveFrom<=(b.effectiveTo||'99999999')&&b.effectiveFrom<=(a.effectiveTo||'99999999');}
async function createPolicy(db,input={},requestedBy={}) {
  const current=requireRole(requestedBy,EDIT_ROLES); await ensureIndexes(db);
  if(clean(input.policyVersionId)===LEGACY_POLICY_ID) fail('LEGACY_POLICY_RESERVED','شناسه سیاست Legacy رزرو شده است.',409);
  const values=validatePolicy(input); const now=new Date(); const row={policyVersionId:newId('CPOL'),...values,status:'draft',revision:1,createdBy:current,submittedBy:null,approvedBy:null,approvedAt:null,auditLog:[audit('policy-created',current)],createdAt:now,updatedAt:now}; row.contentHash=contentHash(row);
  await db.collection(POLICIES).insertOne(row); return {ok:true,policy:row,automaticApproval:false};
}
async function getPolicy(db,id){const row=await db.collection(POLICIES).findOne({policyVersionId:clean(id,100)});if(!row)fail('COMMISSION_POLICY_NOT_FOUND','سیاست پورسانت پیدا نشد.',404);return row;}
async function updatePolicy(db,id,input={},requestedBy={}){
  const current=requireRole(requestedBy,EDIT_ROLES);const row=await getPolicy(db,id);if(row.status!=='draft')fail('COMMISSION_POLICY_IMMUTABLE','فقط Draft قابل ویرایش است.',409);if(Number(input.revision)!==Number(row.revision))fail('COMMISSION_POLICY_CONFLICT','Revision تغییر کرده است.',409);
  const values=validatePolicy(input,row);const patch={...values,revision:Number(row.revision)+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('policy-updated',current)].slice(-300)};patch.contentHash=contentHash({...row,...patch});const result=await db.collection(POLICIES).updateOne({policyVersionId:row.policyVersionId,status:'draft',revision:row.revision},{$set:patch});if(!result.matchedCount)fail('COMMISSION_POLICY_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,policy:{...row,...patch}};
}
async function acquireLock(db,key){const collection=db.collection(APPROVAL_LOCKS);const owner=crypto.randomBytes(8).toString('hex');const now=new Date(),expiresAt=new Date(now.getTime()+15000);const existing=await collection.findOne({lockKey:key});if(existing?.owner&&new Date(existing.expiresAt||0)>now)fail('COMMISSION_POLICY_APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);try{const result=await collection.updateOne({lockKey:key,$or:[{owner:''},{expiresAt:{$lte:now}},{owner}]},{$set:{lockKey:key,owner,expiresAt,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});if(!(result.matchedCount||result.upsertedCount))fail('COMMISSION_POLICY_APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);return{collection,key,owner};}catch(error){if(error?.code===11000)fail('COMMISSION_POLICY_APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);throw error;}}
async function releaseLock(lock){if(lock)await lock.collection.updateOne({lockKey:lock.key,owner:lock.owner},{$set:{owner:'',expiresAt:new Date(0),updatedAt:new Date()}}).catch(()=>{});}
async function transitionPolicy(db,id,action,input={},requestedBy={}){
  const current=requireRole(requestedBy,action==='approve'||action==='retire'?APPROVE_ROLES:EDIT_ROLES);const row=await getPolicy(db,id);if(row.policyVersionId===LEGACY_POLICY_ID)fail('LEGACY_POLICY_IMMUTABLE','سیاست Legacy قابل تغییر نیست.',409);if(Number(input.revision)!==Number(row.revision))fail('COMMISSION_POLICY_CONFLICT','Revision تغییر کرده است.',409);
  const rules={submit:{from:'draft',to:'pending'},approve:{from:'pending',to:'approved'},retire:{from:'approved',to:'retired'}};const rule=rules[action];if(!rule||row.status!==rule.from)fail('COMMISSION_POLICY_STATUS_INVALID','انتقال وضعیت سیاست مجاز نیست.',409);if(action==='approve'&&row.createdBy?.username===current.username)fail('COMMISSION_POLICY_SELF_APPROVAL','ایجادکننده نمی‌تواند سیاست خود را تأیید کند.',403);
  let lock=null;try{if(action==='approve'){lock=await acquireLock(db,row.accountingPeriod);const approved=await db.collection(POLICIES).find({accountingPeriod:row.accountingPeriod,status:'approved'}).toArray();if(approved.some(other=>other.policyVersionId!==row.policyVersionId&&overlaps(row,other)))fail('COMMISSION_POLICY_OVERLAP','سیاست تأییدشده هم‌پوشان برای این دوره وجود دارد.',409);}
    const now=new Date();const patch={status:rule.to,revision:Number(row.revision)+1,updatedAt:now,auditLog:[...(row.auditLog||[]),audit(`policy-${action}`,current,{reason:clean(input.reason,1000)})].slice(-300)};if(action==='submit')patch.submittedBy=current;if(action==='approve'){patch.approvedBy=current;patch.approvedAt=now;}if(action==='retire'){patch.retiredBy=current;patch.retiredAt=now;patch.retirementReason=clean(input.reason,1000);}const result=await db.collection(POLICIES).updateOne({policyVersionId:row.policyVersionId,status:row.status,revision:row.revision},{$set:patch});if(!result.matchedCount)fail('COMMISSION_POLICY_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,policy:{...row,...patch},automaticApproval:false};
  }finally{await releaseLock(lock);}
}
async function listPolicies(db,filters={},requestedBy={}){requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);let rows=await db.collection(POLICIES).find({}).sort({createdAt:-1}).toArray();if(filters.status)rows=rows.filter(row=>row.status===clean(filters.status));return{ok:true,list:rows,total:rows.length,selectable:rows.filter(row=>row.status==='approved'&&row.policyVersionId!==LEGACY_POLICY_ID)};}
async function requireSelectablePolicy(db,policyVersionId){const id=clean(policyVersionId,100);if(!id)fail('COMMISSION_POLICY_REQUIRED','انتخاب سیاست پورسانت تأییدشده الزامی است.');if(id===LEGACY_POLICY_ID)fail('LEGACY_POLICY_NOT_SELECTABLE','سیاست Legacy برای رکورد جدید قابل انتخاب نیست.',409);const policy=await getPolicy(db,id);if(policy.status!=='approved')fail('COMMISSION_POLICY_NOT_APPROVED','سیاست انتخابی باید approved باشد.',409);return policy;}
async function ensureLegacyPolicy(db,requestedBy={}){const current=requireRole(requestedBy,['admin']);await ensureIndexes(db);const now=new Date();const base={policyVersionId:LEGACY_POLICY_ID,name:'Pre-policy historical records',accountingPeriod:'000000',effectiveFrom:'00000000',effectiveTo:'',status:'historical_frozen',description:'Immutable attribution for records created before governed commission policies.',revision:1,createdBy:current,submittedBy:null,approvedBy:null,approvedAt:null,auditLog:[audit('legacy-policy-created',current)],createdAt:now,updatedAt:now,historicalFrozen:true,selectable:false};base.contentHash=contentHash(base);const existing=await db.collection(POLICIES).findOne({policyVersionId:LEGACY_POLICY_ID});if(existing){if(existing.contentHash!==base.contentHash)fail('LEGACY_POLICY_CONFLICT','محتوای سیاست Legacy با قرارداد ثابت تطابق ندارد.',409);return{ok:true,policy:existing,created:false};}await db.collection(POLICIES).insertOne(base);return{ok:true,policy:base,created:true};}
function recordId(type,row){return clean(type==='category_mapping'?row.mappingId:row.rateVersionId,100);}
async function migrateLegacyBindings(db,input={},requestedBy={}){
  const current=requireRole(requestedBy,['admin']);const legacy=await ensureLegacyPolicy(db,current);const migrationRunId=clean(input.migrationRunId,100)||newId('CPMIG');const result={ok:true,migrationRunId,legacyPolicyCreated:legacy.created,created:0,skipped:0,ambiguous:[],missing:[],conflicts:[]};const pending=[];
  for(const [recordType,collectionName] of Object.entries(RECORD_COLLECTIONS)){const rows=await db.collection(collectionName).find({}).toArray();for(const row of rows){if(clean(row.policyVersionId))continue;const id=recordId(recordType,row);if(!id){result.ambiguous.push({recordType,reason:'record-id-missing'});continue;}const hash=sourceHash(row);const existing=await db.collection(BINDINGS).findOne({recordType,recordId:id});if(existing){if(existing.sourceContentHash!==hash)result.conflicts.push({recordType,recordId:id,expected:existing.sourceContentHash,actual:hash});else result.skipped++;continue;}pending.push({recordType,id,hash,row});}}
  if(result.conflicts.length)fail('COMMISSION_POLICY_BINDING_HASH_CONFLICT','Hash منبع یک یا چند اتصال تاریخی تغییر کرده است.',409,{migration:result});
  for(const item of pending){const createdAt=new Date();const binding={bindingId:`CPB-${sha256(`${item.recordType}|${item.id}`).slice(0,24)}`,policyVersionId:LEGACY_POLICY_ID,recordType:item.recordType,recordId:item.id,sourceSchemaVersion:Number(item.row.schemaVersion||1),sourceContentHash:item.hash,bindingReason:'pre-policy historical attribution',migrationRunId,createdBy:current,createdAt,immutable:true};binding.bindingContentHash=sha256(stable({...binding,createdAt:createdAt.toISOString()}));await db.collection(BINDINGS).insertOne(binding);result.created++;}return result;
}
async function attachPolicyBindings(db,recordType,rows=[]){if(!RECORD_COLLECTIONS[recordType]||!rows.length)return rows;const bindings=await db.collection(BINDINGS).find({recordType}).toArray();const byId=new Map(bindings.map(row=>[row.recordId,row]));return rows.map(row=>{if(row.policyVersionId)return row;const binding=byId.get(recordId(recordType,row));return binding?{...row,policyVersionId:binding.policyVersionId,policyBinding:{bindingId:binding.bindingId,sourceContentHash:binding.sourceContentHash,immutable:true},legacyPolicy:true}:row;});}
async function bindingReport(db,requestedBy={}){requireRole(requestedBy,READ_ROLES);const rows=await db.collection(BINDINGS).find({}).toArray();return{ok:true,total:rows.length,categoryMappings:rows.filter(row=>row.recordType==='category_mapping').length,rateVersions:rows.filter(row=>row.recordType==='rate_version').length,legacyPolicyId:LEGACY_POLICY_ID,immutable:true};}
async function activePolicyId(db,date=''){const query={status:'approved'};let rows=await db.collection(POLICIES).find(query).toArray();if(date)rows=rows.filter(row=>row.effectiveFrom<=date&&(!row.effectiveTo||row.effectiveTo>=date));rows.sort((a,b)=>String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));return rows[0]?.policyVersionId||null;}

module.exports={POLICIES,BINDINGS,APPROVAL_LOCKS,LEGACY_POLICY_ID,READ_ROLES,EDIT_ROLES,APPROVE_ROLES,ensureIndexes,createPolicy,updatePolicy,transitionPolicy,listPolicies,getPolicy,requireSelectablePolicy,ensureLegacyPolicy,migrateLegacyBindings,attachPolicyBindings,bindingReport,activePolicyId,_sourceHash:sourceHash,_stable:stable};
