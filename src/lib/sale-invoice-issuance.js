'use strict';

const crypto = require('crypto');

const ATTEMPTS = 'saleIssueLocks';
const FINGERPRINT_LOCKS = 'saleIssuanceFingerprintLocks';
const AUDIT_LOGS = 'invoiceAuditLogs';
const SCHEMA_VERSION = 1;
const RESOLVED_DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

const STATES = Object.freeze({
  PUT_NOT_STARTED:'put_not_started',
  PUT_IN_PROGRESS:'put_in_progress',
  PUT_RESPONSE_AMBIGUOUS:'put_response_ambiguous',
  PUT_SUCCEEDED_RESOLVE_PENDING:'put_succeeded_resolve_pending',
  RESOLVED:'resolved',
  MANUAL_RECONCILIATION_REQUIRED:'manual_reconciliation_required',
  CONFIRMED_PUT_FAILURE:'confirmed_put_failure',
  OPERATOR_RELEASED:'operator_released'
});

const LOCKED_STATES = Object.freeze([
  STATES.PUT_IN_PROGRESS,
  STATES.PUT_RESPONSE_AMBIGUOUS,
  STATES.PUT_SUCCEEDED_RESOLVE_PENDING,
  STATES.MANUAL_RECONCILIATION_REQUIRED
]);
const RESOLUTION_STATES = Object.freeze([
  STATES.PUT_RESPONSE_AMBIGUOUS,
  STATES.PUT_SUCCEEDED_RESOLVE_PENDING,
  STATES.MANUAL_RECONCILIATION_REQUIRED
]);

function clean(value,max=1000){return String(value==null?'':value).trim().slice(0,max);}
function actor(value={}){return{username:clean(value.username||value.user||'system',100),role:clean(value.role||'system',50)};}
function stable(value){
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function nowDate(value){return value instanceof Date?new Date(value):value?new Date(value):new Date();}
function newAttemptId(){return`ISSUE-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;}
function normalizedAttemptId(value){
  const id=clean(value,160).replace(/[^A-Za-z0-9_.:\-]/g,'');
  return id?id.startsWith('sale:')?id:`sale:${id}`:`sale:${newAttemptId()}`;
}
function canonicalLines(body={}){
  return (Array.isArray(body.items)?body.items:[]).map((line,index)=>({
    order:index+1,
    itemCode:clean(line.itemCode||line.ItemNumber||line.itemNumber,100),
    itemGuid:clean(line.itemGuid||line.ItemGuId||line.ItemGuid,100),
    stockNumber:clean(line.stockNumber||line.STNumber||line.stNumber,50),
    stockGuid:clean(line.stockGuid||line.STGuId||line.StockGuId,100),
    quantity:Number(line.quantity||line.Quan||0),
    unitPrice:Number(line.price||line.Price||0),
    lineDiscount:Number(line.discountAmount||line.LineDiscAmount||0),
    serials:(Array.isArray(line.serials)?line.serials:[]).map(serial=>clean(typeof serial==='string'?serial:serial?.serialNumber||serial?.SerialNumber,150)).filter(Boolean).sort()
  }));
}
function canonicalExtras(body={}){
  return (Array.isArray(body.invoiceExtras)?body.invoiceExtras:[]).map((row,index)=>({
    order:index+1,
    accountNumber:clean(row.accountNumber||row.AccountNumber,80),
    accountGuid:clean(row.accountGuid||row.AccountGuId,100),
    amount:Number(row.amount||row.InvExpRowAmount||0),
    type:clean(row.type||'extra',40)
  }));
}
function canonicalInvoiceTotal(body={}){
  const lines=canonicalLines(body);
  const gross=lines.reduce((sum,line)=>sum+(line.quantity*line.unitPrice)-line.lineDiscount,0);
  const extras=canonicalExtras(body).reduce((sum,row)=>sum+Math.max(0,row.amount),0);
  return gross-Number(body.discountAmount||body.DiscAmount||0)+extras;
}
function fingerprintMaterial(body={},mapping={}){
  return{
    invoiceType:2,
    sellerUsername:clean(mapping.username||body.mappingUsername,100),
    store:clean(mapping.storeName||body.storeName,120),
    accountNumber:clean(mapping.cashboxAccountNumber||body.accountNumber,80),
    sellerAccountNumber:clean(mapping.employeeAccountNumber||body.sAccountNumber,80),
    customer:{name:clean(body.customerName,200),mobile:clean(body.mobile,50),nationalCode:clean(body.nationalCode,50)},
    leadId:clean(body.leadId,100),
    invoiceDate:clean(body.invDate,20),
    generalRef:clean(body.generalRef||body.GeneralRef,100),
    discountAmount:Number(body.discountAmount||body.DiscAmount||0),
    invoiceTotal:canonicalInvoiceTotal(body),
    items:canonicalLines(body),
    extras:canonicalExtras(body)
  };
}
function requestFingerprint(body={},mapping={}){return sha(stable(fingerprintMaterial(body,mapping)));}
function requestSnapshot(body={}){
  return{
    customerName:clean(body.customerName,200),mobile:clean(body.mobile,50),nationalCode:clean(body.nationalCode,50),leadId:clean(body.leadId,100),
    invDate:clean(body.invDate,20),generalRef:clean(body.generalRef||body.GeneralRef,100),discountAmount:Number(body.discountAmount||body.DiscAmount||0),
    invoiceExtras:(Array.isArray(body.invoiceExtras)?body.invoiceExtras:[]).map(row=>({...row})),
    items:(Array.isArray(body.items)?body.items:[]).map(row=>({...row})),
    invoiceWithoutLead:Boolean(body.invoiceWithoutLead),leadPenaltyEligible:Boolean(body.leadPenaltyEligible),leadEntryMode:clean(body.leadEntryMode,50)
  };
}
function audit(action,by,at,details={}){return{action,by:actor(by),at:nowDate(at),details:JSON.parse(JSON.stringify(details))};}
function legacyState(row={}){
  if(row.issuanceState)return row.issuanceState;
  if(row.status==='issued')return STATES.RESOLVED;
  if(row.status==='issuing')return STATES.PUT_IN_PROGRESS;
  if(row.status==='failed')return STATES.CONFIRMED_PUT_FAILURE;
  return row.status||STATES.PUT_NOT_STARTED;
}
function isLocked(row={}){return LOCKED_STATES.includes(legacyState(row));}
function publicAttempt(row={}){
  const state=legacyState(row);
  const message=state===STATES.RESOLVED
    ?`فاکتور با شماره ${Number(row.invoiceNumber||0)||''} بازیابی و ثبت شد.`
    :LOCKED_STATES.includes(state)
      ?'فاکتور احتمالاً در شایگان ثبت شده است، اما شماره نهایی آن بازیابی نشد. از صدور مجدد خودداری کنید. سیستم در حال بازیابی یا بررسی فاکتور است.'
      :state===STATES.CONFIRMED_PUT_FAILURE
        ?'عدم ثبت فاکتور به‌صورت قطعی تأیید شده است.'
        :state===STATES.OPERATOR_RELEASED
          ?'قفل درخواست قبلی با تأیید صریح کاربر و برای تداوم عملیات آزاد شده است.'
        :'درخواست صدور آماده ارسال است.';
  return{
    issuanceAttemptId:row.issuanceAttemptId||row._id||'',
    saleIssueKey:row._id||row.issuanceAttemptId||'',
    state,revision:Number(row.revision||0),requestFingerprint:row.requestFingerprint||row.requestFingerprintOriginal||'',
    invoiceNumber:Number(row.invoiceNumber||0),invoiceGuid:clean(row.invoiceGuid,100),printUrl:clean(row.printUrl,300),
    issuanceLocked:LOCKED_STATES.includes(state),resolved:state===STATES.RESOLVED,
    canRetryResolution:RESOLUTION_STATES.includes(state),manualReconciliationRequired:state===STATES.MANUAL_RECONCILIATION_REQUIRED,
    canIssueAgain:[STATES.CONFIRMED_PUT_FAILURE,STATES.OPERATOR_RELEASED].includes(state),
    operatorReleased:state===STATES.OPERATOR_RELEASED,
    actions:LOCKED_STATES.includes(state)?['retry_resolution','view_status','refer_accounting']:[],message,
    updatedAt:row.updatedAt||null
  };
}

async function ensureIndexes(db){
  const existing=new Set((await db.listCollections().toArray()).map(row=>row.name));
  for(const name of [ATTEMPTS,FINGERPRINT_LOCKS,AUDIT_LOGS])if(!existing.has(name))await db.createCollection(name).catch(()=>{});
  await db.collection(ATTEMPTS).createIndex({issuanceAttemptId:1},{unique:true,sparse:true});
  await db.collection(ATTEMPTS).createIndex({requestFingerprint:1,issuanceState:1,updatedAt:-1});
  await db.collection(ATTEMPTS).createIndex({issuanceState:1,updatedAt:-1});
  await db.collection(FINGERPRINT_LOCKS).createIndex({attemptId:1,updatedAt:-1});
  await db.collection(AUDIT_LOGS).createIndex({issuanceAttemptId:1,at:-1});
}

async function transition(db,attemptId,allowed,to,patch={},by={},at=new Date(),action=`state-${to}`){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  if(!row){const error=new Error('Issuance attempt پیدا نشد.');error.code='ISSUANCE_ATTEMPT_NOT_FOUND';error.statusCode=404;throw error;}
  const current=legacyState(row);
  if(!allowed.includes(current)){const error=new Error('وضعیت درخواست صدور تغییر کرده است.');error.code='ISSUANCE_STATE_CONFLICT';error.statusCode=409;error.current=publicAttempt(row);throw error;}
  const nextRevision=Number(row.revision||0)+1;
  const updatedAt=nowDate(at);
  const next={...patch,issuanceState:to,status:to===STATES.RESOLVED?'issued':to,revision:nextRevision,updatedAt,auditLog:[...(row.auditLog||[]),audit(action,by,updatedAt,{from:current,to,...(patch.auditDetails||{})})].slice(-300)};
  delete next.auditDetails;
  const result=await db.collection(ATTEMPTS).updateOne({_id:attemptId,revision:Number(row.revision||0)},{$set:next});
  if(!result.matchedCount){const error=new Error('Revision درخواست صدور هم‌زمان تغییر کرده است.');error.code='ISSUANCE_REVISION_CONFLICT';error.statusCode=409;throw error;}
  const updated={...row,...next};
  await db.collection(FINGERPRINT_LOCKS).updateOne({_id:row.requestFingerprint},{$set:{attemptId,state:to,updatedAt,duplicateWindowUntil:to===STATES.RESOLVED?new Date(updatedAt.getTime()+RESOLVED_DUPLICATE_WINDOW_MS):null}},{upsert:true}).catch(()=>{});
  return updated;
}

async function beginAttempt(db,{attemptId,body={},mapping={},user={},applicationVersion='',gitSha='',at=new Date()}={}){
  await ensureIndexes(db);
  const now=nowDate(at),id=normalizedAttemptId(attemptId||body.issuanceAttemptId||body.saleIssueKey),fingerprint=requestFingerprint(body,mapping);
  const direct=await db.collection(ATTEMPTS).findOne({_id:id});
  if(direct){
    const state=legacyState(direct);
    if(state===STATES.CONFIRMED_PUT_FAILURE){
      if(direct.requestFingerprint&&direct.requestFingerprint!==fingerprint){const error=new Error('محتوای درخواست با Attempt قبلی متفاوت است؛ یک شناسه صدور جدید لازم است.');error.code='ISSUANCE_REQUEST_FINGERPRINT_CHANGED';error.statusCode=409;throw error;}
      const retried=await transition(db,id,[STATES.CONFIRMED_PUT_FAILURE],STATES.PUT_NOT_STARTED,{retryAuthorizedByConfirmedFailure:true,failedAt:null,error:'',auditDetails:{reason:'confirmed-put-failure-retry'}},user,now,'retry-after-confirmed-put-failure');
      return{created:false,mayPut:true,attempt:retried,public:publicAttempt(retried)};
    }
    return{created:false,mayPut:false,attempt:direct,public:publicAttempt(direct)};
  }
  const guard=await db.collection(FINGERPRINT_LOCKS).findOne({_id:fingerprint});
  if(guard?.attemptId){
    const owner=await db.collection(ATTEMPTS).findOne({_id:guard.attemptId});
    if(owner){
      const state=legacyState(owner),duplicateUntil=new Date(guard.duplicateWindowUntil||0).getTime();
      if(isLocked(owner)||state===STATES.PUT_NOT_STARTED||state===STATES.RESOLVED&&duplicateUntil>now.getTime())return{created:false,mayPut:false,attempt:owner,public:publicAttempt(owner),fingerprintMatch:true};
    }
  }
  const guardResult=await db.collection(FINGERPRINT_LOCKS).updateOne(
    {_id:fingerprint,...(guard?.attemptId?{attemptId:guard.attemptId}:{attemptId:{$exists:false}})},
    {$set:{attemptId:id,state:STATES.PUT_NOT_STARTED,updatedAt:now,duplicateWindowUntil:null},$setOnInsert:{createdAt:now}},
    {upsert:!guard}
  ).catch(()=>({matchedCount:0,upsertedCount:0}));
  if(!(guardResult.matchedCount||guardResult.upsertedCount)){
    const winnerGuard=await db.collection(FINGERPRINT_LOCKS).findOne({_id:fingerprint});
    const winner=winnerGuard?.attemptId?await db.collection(ATTEMPTS).findOne({_id:winnerGuard.attemptId}):null;
    if(winner)return{created:false,mayPut:false,attempt:winner,public:publicAttempt(winner),fingerprintMatch:true};
  }
  const row={
    _id:id,issuanceAttemptId:id,schemaVersion:SCHEMA_VERSION,issuanceState:STATES.PUT_NOT_STARTED,status:STATES.PUT_NOT_STARTED,revision:1,
    requestFingerprint:fingerprint,requestFingerprintOriginal:fingerprint,leadId:clean(body.leadId,100),mappingUsername:clean(mapping.username,100),storeName:clean(mapping.storeName,120),
    customerIdentity:{name:clean(body.customerName,200),mobile:clean(body.mobile,50),nationalCode:clean(body.nationalCode,50)},
    requestTimestamp:now,requestSnapshot:requestSnapshot(body),requestSummary:fingerprintMaterial(body,mapping),mapping:{username:clean(mapping.username,100),fullName:clean(mapping.fullName,200),storeName:clean(mapping.storeName,120),cashboxAccountNumber:clean(mapping.cashboxAccountNumber,80),employeeAccountNumber:clean(mapping.employeeAccountNumber,80)},
    requestedBy:actor(user),proposedShayganGuid:clean(body.proposedShayganGuid||body.invoiceGuid,100),applicationVersion:clean(applicationVersion,80),gitSha:clean(gitSha,80),
    putCallCount:0,resolveAttemptCount:0,invoiceNumber:0,invoiceGuid:'',createdAt:now,updatedAt:now,auditLog:[audit('issuance-created',user,now,{state:STATES.PUT_NOT_STARTED,requestFingerprint:fingerprint})]
  };
  const inserted=await db.collection(ATTEMPTS).updateOne({_id:id},{$setOnInsert:row},{upsert:true});
  if(!inserted.upsertedCount){const existing=await db.collection(ATTEMPTS).findOne({_id:id});return{created:false,mayPut:false,attempt:existing,public:publicAttempt(existing)};}
  return{created:true,mayPut:true,attempt:row,public:publicAttempt(row)};
}

async function markPutInProgress(db,attemptId,user={},at=new Date()){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  return transition(db,attemptId,[STATES.PUT_NOT_STARTED],STATES.PUT_IN_PROGRESS,{putStartedAt:nowDate(at),putSentAt:nowDate(at),putCallCount:Number(row?.putCallCount||0)+1},user,at,'invoice-put-started');
}
async function markPutSucceededResolvePending(db,attemptId,response={},user={},at=new Date()){
  const identifiers=response.identifiers||{};
  return transition(db,attemptId,[STATES.PUT_IN_PROGRESS,STATES.PUT_RESPONSE_AMBIGUOUS],STATES.PUT_SUCCEEDED_RESOLVE_PENDING,{putResponseAt:nowDate(at),putHttpStatus:Number(response.httpStatus||0),putResponseIdentifiers:identifiers,resolveEnvelope:response.resolveEnvelope||{},lastTechnicalError:clean(response.error,1000)},user,at,'invoice-put-response-received');
}
async function markAmbiguous(db,attemptId,response={},user={},at=new Date()){
  return transition(db,attemptId,[STATES.PUT_IN_PROGRESS,STATES.PUT_SUCCEEDED_RESOLVE_PENDING],STATES.PUT_RESPONSE_AMBIGUOUS,{putResponseAt:nowDate(at),putHttpStatus:Number(response.httpStatus||0),lastTechnicalError:clean(response.error,1000),manualReason:'put-response-ambiguous'},user,at,'invoice-put-response-ambiguous');
}
async function markManualReconciliation(db,attemptId,resolution={},user={},at=new Date()){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  return transition(db,attemptId,[STATES.PUT_SUCCEEDED_RESOLVE_PENDING,STATES.PUT_RESPONSE_AMBIGUOUS],STATES.MANUAL_RECONCILIATION_REQUIRED,{resolveAttemptCount:Number(row?.resolveAttemptCount||0)+1,lastResolution:resolution,lastTechnicalError:clean(resolution.error||resolution.code,1000),manualReason:resolution.failureStage||'unresolved'},user,at,'invoice-resolution-manual-required');
}
async function markResolved(db,attemptId,resolution={},user={},at=new Date()){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  const invoiceNumber=Number(resolution.invoiceNumber||0),invoiceGuid=clean(resolution.invoiceGuid,100);
  if(!(invoiceNumber>0)){const error=new Error('شماره قطعی فاکتور برای Resolve الزامی است.');error.code='ISSUANCE_RESOLUTION_NUMBER_REQUIRED';throw error;}
  return transition(db,attemptId,[STATES.PUT_SUCCEEDED_RESOLVE_PENDING,STATES.PUT_RESPONSE_AMBIGUOUS,STATES.MANUAL_RECONCILIATION_REQUIRED],STATES.RESOLVED,{resolveAttemptCount:Number(row?.resolveAttemptCount||0)+1,invoiceNumber,invoiceGuid,printUrl:clean(resolution.printUrl,300),result:resolution.result||{},resolvedAt:nowDate(at),lastResolution:resolution,postProcessingStatus:row?.postProcessingStatus||'queued'},user,at,'invoice-resolved');
}
async function markConfirmedFailure(db,attemptId,details={},user={},at=new Date()){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  const allowed=[STATES.PUT_NOT_STARTED,STATES.PUT_IN_PROGRESS,STATES.MANUAL_RECONCILIATION_REQUIRED,STATES.PUT_RESPONSE_AMBIGUOUS];
  const updated=await transition(db,attemptId,allowed,STATES.CONFIRMED_PUT_FAILURE,{failedAt:nowDate(at),error:clean(details.error||'confirmed put failure',1000),putHttpStatus:Number(details.httpStatus||row?.putHttpStatus||0),manualNoInvoiceConfirmedAt:details.manualNoInvoiceConfirmedAt||null,manualNoInvoiceEvidence:details.manualNoInvoiceEvidence||null},user,at,details.manualNoInvoiceConfirmedAt?'manual-no-invoice-confirmed':'invoice-put-confirmed-failure');
  await db.collection(FINGERPRINT_LOCKS).updateOne({_id:updated.requestFingerprint,attemptId},{$set:{state:STATES.CONFIRMED_PUT_FAILURE,duplicateWindowUntil:new Date(0),updatedAt:nowDate(at)}}).catch(()=>{});
  return updated;
}
async function startResolutionRetry(db,attemptId,user={},at=new Date()){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  if(!row){const error=new Error('Issuance attempt پیدا نشد.');error.code='ISSUANCE_ATTEMPT_NOT_FOUND';error.statusCode=404;throw error;}
  if(legacyState(row)===STATES.RESOLVED)return{alreadyResolved:true,attempt:row};
  const updated=await transition(db,attemptId,RESOLUTION_STATES,STATES.PUT_SUCCEEDED_RESOLVE_PENDING,{resolutionRetryStartedAt:nowDate(at),resolutionRetryBy:actor(user)},user,at,'invoice-resolution-retry-started');
  return{alreadyResolved:false,attempt:updated};
}
async function confirmNoInvoice(db,attemptId,input={},user={},at=new Date()){
  if(!['admin','accounting'].includes(clean(user.role,50))){const error=new Error('فقط حسابداری یا مدیر می‌تواند عدم وجود فاکتور را تأیید کند.');error.code='ISSUANCE_RECONCILIATION_FORBIDDEN';error.statusCode=403;throw error;}
  const reason=clean(input.reason,1000),evidenceReference=clean(input.evidenceReference,500);
  if(!reason||!evidenceReference){const error=new Error('دلیل و مرجع بررسی حسابداری الزامی است.');error.code='ISSUANCE_RECONCILIATION_EVIDENCE_REQUIRED';error.statusCode=400;throw error;}
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  if(!row){const error=new Error('Issuance attempt پیدا نشد.');error.code='ISSUANCE_ATTEMPT_NOT_FOUND';error.statusCode=404;throw error;}
  if(Number(input.revision)!==Number(row.revision||0)){const error=new Error('Revision درخواست صدور تغییر کرده است.');error.code='ISSUANCE_REVISION_CONFLICT';error.statusCode=409;throw error;}
  return markConfirmedFailure(db,attemptId,{error:'Accounting confirmed no Shaygan invoice exists',manualNoInvoiceConfirmedAt:nowDate(at),manualNoInvoiceEvidence:{reason,evidenceReference,confirmedBy:actor(user)}},user,at);
}
async function releaseForBusinessContinuity(db,attemptId,input={},user={},at=new Date()){
  if(input.confirmCashboxChecked!==true){const error=new Error('تأیید بررسی حساب صندوق الزامی است.');error.code='ISSUANCE_RELEASE_CONFIRMATION_REQUIRED';error.statusCode=400;throw error;}
  const reason=clean(input.reason,1000);
  if(!reason){const error=new Error('دلیل آزادسازی قفل الزامی است.');error.code='ISSUANCE_RELEASE_REASON_REQUIRED';error.statusCode=400;throw error;}
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  if(!row){const error=new Error('Issuance attempt پیدا نشد.');error.code='ISSUANCE_ATTEMPT_NOT_FOUND';error.statusCode=404;throw error;}
  const releasedAt=nowDate(at),previousState=legacyState(row);
  const evidence={
    actor:actor(user),releasedAt,reason,previousState,
    requestFingerprint:row.requestFingerprint||'',putCallCount:Number(row.putCallCount||0),putHttpStatus:Number(row.putHttpStatus||0),
    knownInvoiceNumber:Number(row.invoiceNumber||row.putResponseIdentifiers?.invoiceNumber||0),
    knownInvoiceGuid:clean(row.invoiceGuid||row.putResponseIdentifiers?.invoiceGuid,100),
    lastResolution:row.lastResolution||null
  };
  const updated=await transition(db,attemptId,LOCKED_STATES,STATES.OPERATOR_RELEASED,{releasedAt,releasedBy:actor(user),releaseReason:reason,releaseEvidence:evidence,auditDetails:evidence},user,releasedAt,'invoice-lock-released-for-business-continuity');
  await db.collection(FINGERPRINT_LOCKS).updateOne({_id:updated.requestFingerprint,attemptId},{$set:{state:STATES.OPERATOR_RELEASED,duplicateWindowUntil:new Date(0),updatedAt:releasedAt}}).catch(()=>{});
  return updated;
}
async function technicalAudit(db,{attemptId,stage,state,response={},resolution=null,user={},at=new Date()}={}){
  const row=await db.collection(ATTEMPTS).findOne({_id:attemptId});
  return db.collection(AUDIT_LOGS).insertOne({
    type:'sale_issue_attempt',issuanceAttemptId:attemptId,saleIssueKey:attemptId,requestFingerprint:row?.requestFingerprint||'',stage:clean(stage,100),state:clean(state,100),
    mappingUsername:row?.mappingUsername||'',storeName:row?.storeName||'',httpStatus:Number(response.status||response.httpStatus||0),responseIdentifiers:response.identifiers||{},
    technicalResult:response.raw??null,technicalError:clean(response.error,2000),resolution:resolution||null,ok:state===STATES.RESOLVED,by:actor(user),at:nowDate(at)
  });
}

module.exports={ATTEMPTS,FINGERPRINT_LOCKS,AUDIT_LOGS,STATES,LOCKED_STATES,RESOLUTION_STATES,SCHEMA_VERSION,requestFingerprint,fingerprintMaterial,requestSnapshot,normalizedAttemptId,legacyState,isLocked,publicAttempt,ensureIndexes,beginAttempt,markPutInProgress,markPutSucceededResolvePending,markAmbiguous,markManualReconciliation,markResolved,markConfirmedFailure,startResolutionRetry,confirmNoInvoice,releaseForBusinessContinuity,technicalAudit,_stable:stable};
