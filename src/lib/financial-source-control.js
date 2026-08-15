'use strict';

const crypto = require('crypto');
const purchase = require('./purchase-layer-dataset');
const fifo = require('./fifo-shadow-engine');
const provenance = require('./fifo-profit-provenance');
const manualCost = require('./manual-cost-resolution');
const { canonicalSaleDate } = require('./jalali-date');
const decimal = require('./accounting-decimal');

const REVIEWS = 'financialSourceReviews';
const ACTIONS = 'financialSourceReviewActions';
const OPENING = 'openingInventoryEvidence';
const PURCHASE_SCOPE_KEY = 'purchase-invoices-types-3-7';
const REVIEW_STATES = Object.freeze(['BUILT','VALIDATED','HUMAN_REVIEW','ACCOUNTING_APPROVED','ADMIN_APPROVED','ACTIVE','REJECTED']);
const GAP_BUCKETS = Object.freeze([
  'NO_PURCHASE_HISTORY','PURCHASE_MISSING_FROM_DATASET','NEGATIVE_CHRONOLOGY',
  'OPENING_INVENTORY_CANDIDATE','PURCHASE_RETURN_CONFLICT','MANUAL_COST_REQUIRED',
  'MANUAL_COST_INELIGIBLE','IDENTITY_MISMATCH','UNSUPPORTED'
]);
const OPENING_STATES = Object.freeze(['draft','pending','approved','rejected']);
const READ_ROLES = Object.freeze(['admin','accounting','manager']);
const EDIT_ROLES = Object.freeze(['admin','accounting']);
const APPROVE_ROLES = Object.freeze(['admin','manager']);
const LEGACY_WARNING = 'این هزینه به فاکتور خرید مشخص متصل نیست و ممکن است دامنه وسیع‌تری نسبت به یک Purchase Layer داشته باشد.';

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function numeric(value){const number=Number(String(value==null?'0':value).replace(/[,،\s]/g,''));return Number.isFinite(number)?number:0;}
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function sha(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function actor(value={}){return {username:clean(value.username||value.user,100),role:clean(value.role,50)};}
function fail(code,message,statusCode=400){const error=new Error(message);error.code=code;error.statusCode=statusCode;throw error;}
function assertRole(by,roles){if(!roles.includes(clean(by?.role,50)))fail('FINANCIAL_SOURCE_CONTROL_FORBIDDEN','دسترسی این نقش به کنترل منابع مالی مجاز نیست.',403);}
function pageArgs(filters={}){return {page:Math.max(1,Number(filters.page||1)),pageSize:Math.max(1,Math.min(Number(filters.pageSize||50),500))};}
function paginate(rows,filters={}){const {page,pageSize}=pageArgs(filters);return {total:rows.length,page,pageSize,list:rows.slice((page-1)*pageSize,page*pageSize)};}
function regex(value){return new RegExp(clean(value,200).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');}
function date8(value,field){return canonicalSaleDate(value,{field});}
function id(prefix){return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;}
function dateValue(value){const time=new Date(value||0).getTime();return Number.isFinite(time)?time:0;}
async function count(collection,query={}){return typeof collection.countDocuments==='function'?Number(await collection.countDocuments(query)):(await collection.find(query).toArray()).length;}

function datasetSummary(row,activeId=''){
  if(!row)return null;
  return {
    datasetId:clean(row.datasetId,100),isActive:row.datasetId===activeId,status:clean(row.status,80),
    activationStatus:clean(row.activationStatus,80),dateFrom:clean(row.sourceDateFrom||row.dateFrom,8),
    dateTo:clean(row.sourceDateTo||row.dateTo,8),invoiceCount:Number(row.purchaseInvoiceCount||row.invoiceCount||0),
    lineCount:Number(row.purchaseLineCount||row.lineCount||row.summary?.allocationCount||0),
    itemCount:Number(row.uniqueItemCount||row.itemCount||row.summary?.itemCount||0),
    returnCount:Number(row.purchaseReturnLineCount||row.returnLineCount||row.summary?.purchaseReturnCount||0),
    duplicateCount:Number(row.validation?.duplicateIdentityCount||row.validation?.duplicateLayerCount||0),
    sourceFingerprint:clean(row.sourceFingerprint,128),layerFingerprint:clean(row.layerFingerprint||row.allocationFingerprint,128),
    algorithmVersion:clean(row.algorithmVersion||row.buildMode||row.mode,120),createdAt:row.createdAt||null,
    completedAt:row.completedAt||row.finishedAt||null,sourceSaleSnapshotId:clean(row.sourceSaleSnapshotId,100),
    sourcePurchaseDatasetId:clean(row.sourcePurchaseDatasetId,100),manualResolutionSetFingerprint:clean(row.manualResolutionSetFingerprint,128),
    facts:Number(row.provenanceSummary?.facts||row.summary?.factCount||0),allocations:Number(row.summary?.allocationCount||0),
    exceptions:Number(row.summary?.exceptionCount||row.unresolvedExceptionCount||0),validation:row.validation||null
  };
}

async function contexts(db,filters={}){
  const purchaseState=await db.collection(purchase.STATE).findOne({scopeKey:PURCHASE_SCOPE_KEY});
  const activePurchaseId=clean(purchaseState?.activeDatasetId,100);
  const activePurchase=activePurchaseId?await db.collection(purchase.DATASETS).findOne({datasetId:activePurchaseId}):null;
  const purchaseCandidateId=clean(filters.purchaseCandidateId,100);
  const purchaseCandidate=purchaseCandidateId
    ? await db.collection(purchase.DATASETS).findOne({datasetId:purchaseCandidateId})
    : await db.collection(purchase.DATASETS).findOne({datasetId:{$ne:activePurchaseId},status:'completed'},{sort:{completedAt:-1,createdAt:-1}});
  const fifoState=await db.collection(fifo.STATE).findOne({scopeKey:fifo.SCOPE_KEY});
  const activeFifoId=clean(fifoState?.activeDatasetId,100);
  const activeFifo=activeFifoId?await db.collection(fifo.DATASETS).findOne({datasetId:activeFifoId}):null;
  const fifoCandidateId=clean(filters.fifoCandidateId,100);
  const fifoCandidate=fifoCandidateId
    ? await db.collection(fifo.DATASETS).findOne({datasetId:fifoCandidateId})
    : await db.collection(fifo.DATASETS).findOne({datasetId:{$ne:activeFifoId},status:'completed'},{sort:{completedAt:-1,createdAt:-1}});
  const manualFingerprint=await manualCost.approvedSetFingerprint(db);
  return {purchaseState,activePurchaseId,activePurchase,purchaseCandidate,fifoState,activeFifoId,activeFifo,fifoCandidate,manualFingerprint};
}

async function reviewFor(db,entityType,entityId,sourceFingerprint='',initialState='BUILT'){
  const review=await db.collection(REVIEWS).findOne({entityType,entityId});
  if(review)return review;
  return {entityType,entityId,state:initialState,revision:0,sourceFingerprint:clean(sourceFingerprint,128),auditLog:[],persisted:false};
}

async function preciseDatasetSummary(db,row,activeId,type){const summary=datasetSummary(row,activeId);if(!summary)return null;if(type==='purchase'){const rows=await db.collection(purchase.LAYERS).find({datasetId:row.datasetId}).toArray();summary.lineCount=rows.length;summary.invoiceCount=new Set(rows.map(value=>`${value.sourceInvoiceType||''}:${value.purchaseInvoiceNo||''}`)).size;summary.itemCount=new Set(rows.map(value=>clean(value.itemGuid||value.itemCode,100)).filter(Boolean)).size;summary.returnCount=rows.filter(value=>value.layerKind==='purchase-return').length;}else{summary.allocations=await count(db.collection(fifo.ALLOCATIONS),{datasetId:row.datasetId});summary.exceptions=await count(db.collection(fifo.EXCEPTIONS),{datasetId:row.datasetId});summary.facts=(await db.collection(fifo.ALLOCATIONS).aggregate([{$match:{datasetId:row.datasetId,saleInvoiceType:2}},{$group:{_id:'$saleLineId'}},{$count:'count'}]).toArray())[0]?.count||0;}return summary;}

async function overview(db,filters={},by={}){
  assertRole(by,READ_ROLES);
  const context=await contexts(db,filters);
  const purchaseReview=context.purchaseCandidate?await reviewFor(db,'purchase-dataset',context.purchaseCandidate.datasetId,context.purchaseCandidate.sourceFingerprint,context.purchaseCandidate.validation?.valid?'VALIDATED':'BUILT'):null;
  const fifoReview=context.fifoCandidate?await reviewFor(db,'fifo-dataset',context.fifoCandidate.datasetId,context.fifoCandidate.sourceFingerprint,context.fifoCandidate.validation?.valid?'VALIDATED':'BUILT'):null;
  const [activePurchase,candidatePurchase,activeFifo,candidateFifo]=await Promise.all([preciseDatasetSummary(db,context.activePurchase,context.activePurchaseId,'purchase'),preciseDatasetSummary(db,context.purchaseCandidate,context.activePurchaseId,'purchase'),preciseDatasetSummary(db,context.activeFifo,context.activeFifoId,'fifo'),preciseDatasetSummary(db,context.fifoCandidate,context.activeFifoId,'fifo')]);
  return {ok:true,readOnly:true,generatedAt:new Date(),purchase:{active:activePurchase,candidate:candidatePurchase,review:purchaseReview},fifo:{active:activeFifo,candidate:candidateFifo,review:fifoReview},manualCostSet:context.manualFingerprint,activationAvailable:false};
}

function layerProjection(row={}){return {
  identity:clean(row.purchaseLineIdentity,500),invoiceNumber:Number(row.purchaseInvoiceNo||0),purchaseDate:clean(row.purchaseInvoiceDate,8),
  supplierIdentity:clean(row.supplierAccountNumber||row.supplierGuid,100),supplierName:clean(row.supplierName,250),
  itemCode:clean(row.itemCode,100),itemGuid:clean(row.itemGuid,100),itemName:clean(row.itemDescription,300),
  quantity:numeric(row.netPurchasedQuantity??row.originalQuantity??row.returnedQuantity),unitCost:numeric(row.netUnitCost??row.grossUnitCost),
  totalCost:numeric(row.netPurchasedQuantity??row.originalQuantity??row.returnedQuantity)*numeric(row.netUnitCost??row.grossUnitCost),
  layerKind:clean(row.layerKind,50),sourceFingerprint:clean(row.sourceHash,128),returnMatchStatus:clean(row.returnMatchStatus,80),
  sourceInvoiceType:Number(row.sourceInvoiceType||0),datasetId:clean(row.datasetId,100)
};}
function sameNumber(a,b){return Math.abs(numeric(a)-numeric(b))<=0.000001;}
function changeOf(oldRow,newRow){
  if(!oldRow)return ['NEW_LINE'];if(!newRow)return ['REMOVED_LINE'];const changes=[];
  if(!sameNumber(oldRow.quantity,newRow.quantity))changes.push('CHANGED_QUANTITY');
  if(!sameNumber(oldRow.unitCost,newRow.unitCost))changes.push('CHANGED_UNIT_COST');
  if(clean(oldRow.supplierIdentity)!==clean(newRow.supplierIdentity)||clean(oldRow.supplierName)!==clean(newRow.supplierName))changes.push('CHANGED_SUPPLIER');
  if(clean(oldRow.sourceFingerprint)!==clean(newRow.sourceFingerprint)&&!changes.length)changes.push('CHANGED_SOURCE');
  return changes.length?changes:['UNCHANGED'];
}
function filterDelta(rows,filters={}){
  let out=rows;
  if(clean(filters.invoiceNumber))out=out.filter(row=>String(row.invoiceNumber).includes(clean(filters.invoiceNumber)));
  if(clean(filters.item))out=out.filter(row=>regex(filters.item).test(`${row.itemCode} ${row.itemGuid} ${row.itemName}`));
  if(clean(filters.supplier))out=out.filter(row=>regex(filters.supplier).test(`${row.supplierIdentity} ${row.supplierName}`));
  if(clean(filters.changeType))out=out.filter(row=>row.changeTypes.includes(clean(filters.changeType)));
  if(clean(filters.dataset)==='active')out=out.filter(row=>row.active);if(clean(filters.dataset)==='candidate')out=out.filter(row=>row.candidate);
  if(clean(filters.dateFrom))out=out.filter(row=>row.purchaseDate>=clean(filters.dateFrom));if(clean(filters.dateTo))out=out.filter(row=>row.purchaseDate<=clean(filters.dateTo));
  if(String(filters.highValue)==='true')out=out.filter(row=>numeric(row.totalCost)>=100000000);
  return out;
}
async function purchaseDelta(db,filters={},by={}){
  assertRole(by,READ_ROLES);const context=await contexts(db,filters);
  if(!context.activePurchaseId||!context.purchaseCandidate?.datasetId)return {ok:true,readOnly:true,activeDatasetId:context.activePurchaseId,candidateDatasetId:context.purchaseCandidate?.datasetId||'',summary:{},...paginate([],filters)};
  const [oldRows,newRows]=await Promise.all([
    db.collection(purchase.LAYERS).find({datasetId:context.activePurchaseId}).toArray(),
    db.collection(purchase.LAYERS).find({datasetId:context.purchaseCandidate.datasetId}).toArray()
  ]);
  const oldMap=new Map(oldRows.map(row=>[clean(row.purchaseLineIdentity,500),layerProjection(row)]));
  const newMap=new Map(newRows.map(row=>[clean(row.purchaseLineIdentity,500),layerProjection(row)]));
  const identities=[...new Set([...oldMap.keys(),...newMap.keys()])];
  let rows=identities.map(identity=>{const active=oldMap.get(identity)||null,candidate=newMap.get(identity)||null,changeTypes=changeOf(active,candidate);return {...(candidate||active),identity,active,candidate,changeTypes,changeStatus:changeTypes.join(', ')};});
  const duplicateIdentities=newRows.length-newMap.size;
  const activeInvoices=new Set(oldRows.map(row=>Number(row.purchaseInvoiceNo||0))),candidateInvoices=new Set(newRows.map(row=>Number(row.purchaseInvoiceNo||0)));
  const summary={newInvoices:[...candidateInvoices].filter(value=>!activeInvoices.has(value)).length,removedInvoices:[...activeInvoices].filter(value=>!candidateInvoices.has(value)).length,newLines:rows.filter(row=>row.changeTypes.includes('NEW_LINE')).length,removedLines:rows.filter(row=>row.changeTypes.includes('REMOVED_LINE')).length,changedLines:rows.filter(row=>row.changeTypes.some(value=>value.startsWith('CHANGED'))).length,changedQuantity:rows.filter(row=>row.changeTypes.includes('CHANGED_QUANTITY')).length,changedUnitCost:rows.filter(row=>row.changeTypes.includes('CHANGED_UNIT_COST')).length,changedSupplier:rows.filter(row=>row.changeTypes.includes('CHANGED_SUPPLIER')).length,duplicateIdentities,dateRange:{active:{from:context.activePurchase?.sourceDateFrom||'',to:context.activePurchase?.sourceDateTo||''},candidate:{from:context.purchaseCandidate?.sourceDateFrom||'',to:context.purchaseCandidate?.sourceDateTo||''}},previousLayerPreservationPass:rows.every(row=>!row.changeTypes.includes('REMOVED_LINE'))};
  rows=filterDelta(rows,filters).sort((a,b)=>b.invoiceNumber-a.invoiceNumber||a.identity.localeCompare(b.identity));
  return {ok:true,readOnly:true,activeDatasetId:context.activePurchaseId,candidateDatasetId:context.purchaseCandidate.datasetId,summary,...paginate(rows,filters)};
}

function gapBucket(row={},evidence={}){
  const reason=clean(row.unknownReason||row.reason||row.code,300).toUpperCase();
  if(/RETURN/.test(reason)||evidence.returnConflict)return 'PURCHASE_RETURN_CONFLICT';
  if(/IDENTITY|GUID|ITEM.?CODE/.test(reason))return 'IDENTITY_MISMATCH';
  if(/CHRONO|AFTER.?SALE|NEGATIVE/.test(reason))return 'NEGATIVE_CHRONOLOGY';
  if(evidence.recoveredPurchase)return 'PURCHASE_MISSING_FROM_DATASET';
  if(evidence.manualIneligible)return 'MANUAL_COST_INELIGIBLE';
  if(evidence.openingCandidate)return 'OPENING_INVENTORY_CANDIDATE';
  if(evidence.hasAnyPurchase)return 'PURCHASE_MISSING_FROM_DATASET';
  if(evidence.manualPossible)return 'MANUAL_COST_REQUIRED';
  if(!clean(row.itemCode||row.itemGuid))return 'UNSUPPORTED';
  return 'NO_PURCHASE_HISTORY';
}
const GAP_REMEDIATION={NO_PURCHASE_HISTORY:'recover purchase history',PURCHASE_MISSING_FROM_DATASET:'rebuild Purchase Dataset',NEGATIVE_CHRONOLOGY:'create Opening Inventory Evidence',OPENING_INVENTORY_CANDIDATE:'create Opening Inventory Evidence',PURCHASE_RETURN_CONFLICT:'investigate return',MANUAL_COST_REQUIRED:'create Manual Cost',MANUAL_COST_INELIGIBLE:'correct Manual Cost governance',IDENTITY_MISMATCH:'investigate item identity',UNSUPPORTED:'unresolved / keep Unknown'};
async function sourceGaps(db,filters={},by={}){
  assertRole(by,READ_ROLES);const context=await contexts(db,filters);const datasetId=clean(filters.fifoDatasetId||context.fifoCandidate?.datasetId||context.activeFifoId,100);
  if(!datasetId)return {ok:true,readOnly:true,datasetId:'',summary:[],...paginate([],filters)};
  const [unknown,recovery,manuals,purchaseRows,returns]=await Promise.all([
    db.collection(fifo.ALLOCATIONS).find({datasetId,sourceType:'unknown_cost'}).toArray(),
    db.collection('purchaseLayerRecoveryCandidates').find({}).toArray(),db.collection(manualCost.COLLECTION).find({}).toArray(),
    db.collection(purchase.LAYERS).find({datasetId:context.purchaseCandidate?.datasetId||context.activePurchaseId}).toArray(),
    db.collection(purchase.LAYERS).find({datasetId:context.purchaseCandidate?.datasetId||context.activePurchaseId,layerKind:'purchase-return'}).toArray()
  ]);
  const recovered=new Set(recovery.map(row=>clean(row.itemCode||row.sourceItemCode,100)).filter(Boolean));
  const purchased=new Set(purchaseRows.map(row=>clean(row.itemCode,100)).filter(Boolean));
  const returnItems=new Set(returns.filter(row=>!['matched','not-applicable'].includes(clean(row.returnMatchStatus))).map(row=>clean(row.itemCode,100)));
  const manualByItem=new Map();for(const row of manuals){const key=clean(row.itemCode||row.itemGuid,100);if(!manualByItem.has(key))manualByItem.set(key,[]);manualByItem.get(key).push(row);}
  let rows=unknown.map(row=>{const item=clean(row.itemCode||row.itemGuid,100),manualRows=manualByItem.get(item)||[],saleValue=numeric(row.allocatedSaleValueExact??row.allocatedSaleValue),quantity=numeric(row.quantityExact??row.unknownQty);const evidence={recoveredPurchase:recovered.has(item),hasAnyPurchase:purchased.has(item),returnConflict:returnItems.has(item),manualIneligible:manualRows.length>0&&!manualRows.some(value=>value.status==='approved'&&value.effectiveFrom),manualPossible:manualRows.length===0,openingCandidate:/BEFORE|OPENING|CHRONO/.test(clean(row.unknownReason).toUpperCase())};const bucket=gapBucket(row,evidence);return {datasetId,saleLineId:clean(row.saleLineId,500),saleInvoiceNumber:Number(row.saleInvoiceNo||0),saleDate:clean(row.saleDate,8),sellerIdentity:clean(row.sellerAccountNumber||row.sellerIdentity,100),sellerName:clean(row.sellerName,200),category:clean(row.officialProductCategoryName||row.productCategory,200),itemCode:clean(row.itemCode,100),itemGuid:clean(row.itemGuid,100),itemName:clean(row.itemDescription,300),quantity,saleValue,bucket,technicalReason:clean(row.unknownReason||row.code,300),recommendedRemediation:GAP_REMEDIATION[bucket],attemptedResolution:{officialPurchase:evidence.hasAnyPurchase,recoveredPurchase:evidence.recoveredPurchase,manualEvidence:manualRows.map(value=>({resolutionId:value.resolutionId,status:value.status,effectiveFrom:value.effectiveFrom,effectiveTo:value.effectiveTo}))}};});
  if(clean(filters.bucket))rows=rows.filter(row=>row.bucket===clean(filters.bucket));if(clean(filters.seller))rows=rows.filter(row=>regex(filters.seller).test(`${row.sellerIdentity} ${row.sellerName}`));if(clean(filters.category))rows=rows.filter(row=>regex(filters.category).test(row.category));if(clean(filters.item))rows=rows.filter(row=>regex(filters.item).test(`${row.itemCode} ${row.itemGuid} ${row.itemName}`));if(clean(filters.invoice))rows=rows.filter(row=>String(row.saleInvoiceNumber).includes(clean(filters.invoice)));if(clean(filters.dateFrom))rows=rows.filter(row=>row.saleDate>=clean(filters.dateFrom));if(clean(filters.dateTo))rows=rows.filter(row=>row.saleDate<=clean(filters.dateTo));if(clean(filters.saleValueMin))rows=rows.filter(row=>row.saleValue>=numeric(filters.saleValueMin));if(clean(filters.saleValueMax))rows=rows.filter(row=>row.saleValue<=numeric(filters.saleValueMax));
  const grouped=new Map();for(const bucket of GAP_BUCKETS)grouped.set(bucket,{bucket,lineCount:0,quantity:0,saleValue:0,sellers:new Set(),categories:new Set(),items:new Set()});for(const row of rows){const group=grouped.get(row.bucket);group.lineCount++;group.quantity+=row.quantity;group.saleValue+=row.saleValue;if(row.sellerIdentity)group.sellers.add(row.sellerIdentity);if(row.category)group.categories.add(row.category);if(row.itemCode||row.itemGuid)group.items.add(row.itemCode||row.itemGuid);}
  const summary=[...grouped.values()].map(row=>({bucket:row.bucket,lineCount:row.lineCount,quantity:row.quantity,saleValue:row.saleValue,affectedSellers:row.sellers.size,affectedCategories:row.categories.size,affectedItems:row.items.size})).sort((a,b)=>b.saleValue-a.saleValue);
  rows.sort((a,b)=>b.saleValue-a.saleValue||b.saleInvoiceNumber-a.saleInvoiceNumber);return {ok:true,readOnly:true,datasetId,summary,...paginate(rows,filters)};
}

function evidenceProjection(row,type){return {evidenceType:type,evidenceId:clean(row.resolutionId||row.evidenceId,100),status:clean(row.status,50),scope:clean(row.resolutionScope||'item',50),itemGuid:clean(row.itemGuid,100),itemCode:clean(row.itemCode,100),purchaseDatasetId:clean(row.purchaseDatasetId,100),purchaseLineIdentity:clean(row.purchaseLineIdentity,500),effectiveFrom:clean(row.effectiveFrom||row.openingDate,8),effectiveTo:clean(row.effectiveTo,8),costExact:clean(row.manualCostExact||row.unitCostExact||row.manualCost,100),quantityExact:clean(row.targetQuantityExact||row.quantityExact,100),totalCostExact:clean(row.totalCostExact,100),sourceType:clean(row.sourceType,100),sourceReference:clean(row.sourceReference,500),description:clean(row.description||row.reason,1000),creator:row.createdBy||null,approver:row.approvedBy||null,revision:Number(row.revision||0),supersedes:clean(row.supersedesResolutionId||row.supersedesEvidenceId,100),fingerprint:clean(row.contentHash,128),impactPreview:row.impactPreview||null,auditLog:Array.isArray(row.auditLog)?row.auditLog:[],legacyWarning:type==='MANUAL_COST_ITEM_LEGACY'?LEGACY_WARNING:''};}
async function costEvidence(db,filters={},by={}){
  assertRole(by,READ_ROLES);const [manuals,opening]=await Promise.all([db.collection(manualCost.COLLECTION).find({}).toArray(),db.collection(OPENING).find({}).toArray()]);
  let rows=[...manuals.map(row=>evidenceProjection(row,row.resolutionScope==='purchase_layer'?'MANUAL_COST_PURCHASE_LAYER':'MANUAL_COST_ITEM_LEGACY')),...opening.map(row=>evidenceProjection(row,'OPENING_INVENTORY_EVIDENCE'))];
  if(clean(filters.type))rows=rows.filter(row=>row.evidenceType===clean(filters.type));if(clean(filters.status))rows=rows.filter(row=>row.status===clean(filters.status));if(clean(filters.item))rows=rows.filter(row=>regex(filters.item).test(`${row.itemCode} ${row.itemGuid}`));rows.sort((a,b)=>dateValue(b.createdAt||b.auditLog?.at)-dateValue(a.createdAt||a.auditLog?.at)||a.evidenceId.localeCompare(b.evidenceId));return {ok:true,readOnly:true,legacyWarning:LEGACY_WARNING,...paginate(rows,filters)};
}

function openingProjection(input={}){let exact;try{exact=decimal.allocation(input.quantityExact??input.quantity??0,input.unitCostExact??input.unitCost??0);}catch(_){fail('OPENING_EVIDENCE_DECIMAL_INVALID','مقدار یا بهای واحد معتبر نیست.');}return {itemGuid:clean(input.itemGuid,100),itemCode:clean(input.itemCode,100),openingDate:date8(input.openingDate,'openingDate'),quantityExact:exact.quantityExact,unitCostExact:exact.unitCostExact,totalCostExact:exact.allocationValueExact,sourceType:clean(input.sourceType,100),sourceReference:clean(input.sourceReference,500),description:clean(input.description,2000),attachment:input.attachment&&typeof input.attachment==='object'?{name:clean(input.attachment.name,200),reference:clean(input.attachment.reference,500),sha256:clean(input.attachment.sha256,64)}:null};}
function validateOpening(input){const row=openingProjection(input);if(!row.itemGuid&&!row.itemCode)fail('OPENING_EVIDENCE_ITEM_REQUIRED','هویت کالا الزامی است.');if(decimal.parse(row.quantityExact,decimal.QUANTITY_SCALE)<=0n)fail('OPENING_EVIDENCE_QUANTITY_REQUIRED','مقدار موجودی آغازین باید مثبت باشد.');if(decimal.parse(row.unitCostExact,decimal.UNIT_COST_SCALE)<=0n)fail('OPENING_EVIDENCE_COST_REQUIRED','بهای واحد باید مثبت باشد.');if(!row.sourceType||!row.sourceReference||!row.description)fail('OPENING_EVIDENCE_SOURCE_REQUIRED','نوع، مرجع و شرح مدرک الزامی است.');return row;}
function openingHash(row){return sha(stable(openingProjection(row)));}
async function createOpeningDraft(db,input={},by={}){assertRole(by,EDIT_ROLES);const now=new Date(),projection=validateOpening(input),identity=projection.itemGuid?{itemGuid:projection.itemGuid}:{itemCode:projection.itemCode};const existing=await db.collection(OPENING).findOne({...identity,openingDate:projection.openingDate,status:{$in:['draft','pending','approved']}});if(existing)fail('OPENING_EVIDENCE_DUPLICATE','برای این کالا و تاریخ یک مدرک باز یا تأییدشده وجود دارد.',409);const evidenceId=id('OIE');const record={evidenceId,schemaVersion:1,...projection,status:'draft',revision:1,contentHash:openingHash(projection),createdBy:actor(by),createdAt:now,updatedAt:now,immutableAfterApproval:true,auditLog:[{action:'created',by:actor(by),at:now,fromStatus:null,toStatus:'draft',revision:1,reason:clean(input.reason||input.description,1000),contentHash:openingHash(projection)}]};await db.collection(OPENING).insertOne(record);return {ok:true,evidence:record};}
async function updateOpeningDraft(db,evidenceId,input={},by={}){assertRole(by,EDIT_ROLES);const record=await db.collection(OPENING).findOne({evidenceId:clean(evidenceId,100)});if(!record)fail('OPENING_EVIDENCE_NOT_FOUND','مدرک موجودی آغازین پیدا نشد.',404);if(record.status!=='draft')fail('OPENING_EVIDENCE_IMMUTABLE','فقط Draft قابل ویرایش است.',409);if(Number(input.revision)!==Number(record.revision))fail('OPENING_EVIDENCE_REVISION_CONFLICT','رکورد توسط کاربر دیگری تغییر کرده است.',409);const projection=validateOpening({...record,...input}),now=new Date(),nextRevision=record.revision+1,contentHash=openingHash(projection),audit={action:'updated',by:actor(by),at:now,fromStatus:'draft',toStatus:'draft',revision:nextRevision,reason:clean(input.reason||input.description,1000),previousContentHash:record.contentHash,contentHash};const result=await db.collection(OPENING).updateOne({evidenceId:record.evidenceId,status:'draft',revision:record.revision},{$set:{...projection,contentHash,revision:nextRevision,updatedAt:now},$push:{auditLog:audit}});if(!result.matchedCount)fail('OPENING_EVIDENCE_REVISION_CONFLICT','رکورد هم‌زمان تغییر کرده است.',409);return {ok:true,evidence:await db.collection(OPENING).findOne({evidenceId:record.evidenceId})};}
async function transitionOpening(db,evidenceId,action,input={},by={}){const record=await db.collection(OPENING).findOne({evidenceId:clean(evidenceId,100)});if(!record)fail('OPENING_EVIDENCE_NOT_FOUND','مدرک موجودی آغازین پیدا نشد.',404);const revision=Number(input.revision);if(revision!==Number(record.revision))fail('OPENING_EVIDENCE_REVISION_CONFLICT','رکورد توسط کاربر دیگری تغییر کرده است.',409);let next;if(action==='submit'){assertRole(by,EDIT_ROLES);if(record.status!=='draft')fail('OPENING_EVIDENCE_INVALID_TRANSITION','فقط Draft قابل ارسال است.',409);next='pending';}else if(action==='approve'){assertRole(by,APPROVE_ROLES);if(record.status!=='pending')fail('OPENING_EVIDENCE_INVALID_TRANSITION','فقط Pending قابل تأیید است.',409);if(actor(by).username===record.createdBy?.username)fail('OPENING_EVIDENCE_SELF_APPROVAL','تأیید مستقل الزامی است.',403);next='approved';}else if(action==='reject'){assertRole(by,APPROVE_ROLES);if(record.status!=='pending')fail('OPENING_EVIDENCE_INVALID_TRANSITION','فقط Pending قابل رد است.',409);next='rejected';}else fail('OPENING_EVIDENCE_ACTION_INVALID','عملیات نامعتبر است.');const reason=clean(input.reason||input.note,1000);if(action==='reject'&&!reason)fail('OPENING_EVIDENCE_REASON_REQUIRED','دلیل رد الزامی است.');const now=new Date(),nextRevision=record.revision+1,audit={action,by:actor(by),at:now,fromStatus:record.status,toStatus:next,revision:nextRevision,reason,contentHash:record.contentHash};const set={status:next,revision:nextRevision,updatedAt:now,...(action==='submit'?{submittedBy:actor(by),submittedAt:now}:{}),...(action==='approve'?{approvedBy:actor(by),approvedAt:now}:{}),...(action==='reject'?{rejectedBy:actor(by),rejectedAt:now}:{})};const result=await db.collection(OPENING).updateOne({evidenceId:record.evidenceId,revision:record.revision,status:record.status},{$set:set,$push:{auditLog:audit}});if(!result.matchedCount)fail('OPENING_EVIDENCE_REVISION_CONFLICT','رکورد هم‌زمان تغییر کرده است.',409);return {ok:true,evidence:await db.collection(OPENING).findOne({evidenceId:record.evidenceId})};}

async function candidateReview(db,entityType,entityId,action,input={},by={}){assertRole(by,['admin','accounting','manager']);if(!['purchase-dataset','fifo-dataset'].includes(entityType))fail('SOURCE_REVIEW_TYPE_INVALID','نوع کاندیدا نامعتبر است.');const source=await db.collection(entityType==='purchase-dataset'?purchase.DATASETS:fifo.DATASETS).findOne({datasetId:clean(entityId,100)});if(!source)fail('SOURCE_REVIEW_NOT_FOUND','کاندیدا پیدا نشد.',404);const existing=await db.collection(REVIEWS).findOne({entityType,entityId:source.datasetId});const current=existing?.state||(source.validation?.valid?'VALIDATED':'BUILT'),revision=Number(existing?.revision||0);if(input.revision!=null&&Number(input.revision)!==revision)fail('SOURCE_REVIEW_REVISION_CONFLICT','نسخه Review تغییر کرده است.',409);let next;if(action==='start-review'){assertRole(by,EDIT_ROLES);if(!['BUILT','VALIDATED'].includes(current))fail('SOURCE_REVIEW_INVALID_TRANSITION','کاندیدا قبلاً وارد Review شده است.',409);next='HUMAN_REVIEW';}else if(action==='accounting-approve'){assertRole(by,EDIT_ROLES);if(current!=='HUMAN_REVIEW')fail('SOURCE_REVIEW_INVALID_TRANSITION','ابتدا Human Review لازم است.',409);next='ACCOUNTING_APPROVED';}else if(action==='admin-approve'){assertRole(by,APPROVE_ROLES);if(current!=='ACCOUNTING_APPROVED')fail('SOURCE_REVIEW_INVALID_TRANSITION','تأیید حسابداری لازم است.',409);const username=actor(by).username,builder=actor(source.requestedBy||source.createdBy).username;if(existing?.createdBy?.username===username||existing?.accountingApprovedBy?.username===username||(builder&&builder===username))fail('SOURCE_REVIEW_SELF_APPROVAL','تأیید نهایی باید مستقل از سازنده و بررسی‌کننده باشد.',403);next='ADMIN_APPROVED';}else if(action==='reject'){assertRole(by,APPROVE_ROLES);if(!['HUMAN_REVIEW','ACCOUNTING_APPROVED'].includes(current))fail('SOURCE_REVIEW_INVALID_TRANSITION','این Review قابل رد نیست.',409);next='REJECTED';}else fail('SOURCE_REVIEW_ACTION_INVALID','عملیات Review نامعتبر است.');const now=new Date(),nextRevision=revision+1,fingerprint=clean(source.sourceFingerprint||source.allocationFingerprint,128),audit={action,actor:actor(by),at:now,revision:nextRevision,previousState:current,newState:next,reason:clean(input.reason||input.note,1000),sourceFingerprint:fingerprint};const set={reviewId:existing?.reviewId||id('FSR'),entityType,entityId:source.datasetId,state:next,revision:nextRevision,sourceFingerprint:fingerprint,updatedAt:now,...(!existing?{createdBy:actor(by),createdAt:now}:{}),...(action==='accounting-approve'?{accountingApprovedBy:actor(by),accountingApprovedAt:now}:{}),...(action==='admin-approve'?{adminApprovedBy:actor(by),adminApprovedAt:now,activationAuthorized:false}:{}),...(action==='reject'?{rejectedBy:actor(by),rejectedAt:now}:{})};const result=await db.collection(REVIEWS).updateOne({entityType,entityId:source.datasetId,revision},{$set:set,$push:{auditLog:audit}},{upsert:!existing});if(existing&&!result.matchedCount)fail('SOURCE_REVIEW_REVISION_CONFLICT','Review هم‌زمان تغییر کرده است.',409);return {ok:true,review:await db.collection(REVIEWS).findOne({entityType,entityId:source.datasetId}),activationPerformed:false};}
async function lineReview(db,input={},by={}){assertRole(by,['admin','accounting','manager']);const action=clean(input.action,50),entityType=clean(input.entityType,50),entityId=clean(input.entityId,100),lineIdentity=clean(input.lineIdentity,500);if(!['reviewed','mismatch','note'].includes(action))fail('SOURCE_LINE_ACTION_INVALID','عملیات ردیف نامعتبر است.');if(!['purchase-dataset','fifo-dataset'].includes(entityType)||!entityId||!lineIdentity)fail('SOURCE_LINE_IDENTITY_REQUIRED','نوع، شناسه Candidate و ردیف الزامی است.');if(action!=='reviewed'&&!clean(input.note,1000))fail('SOURCE_LINE_NOTE_REQUIRED','شرح اقدام الزامی است.');const datasetCollection=entityType==='purchase-dataset'?purchase.DATASETS:fifo.DATASETS,lineCollection=entityType==='purchase-dataset'?purchase.LAYERS:fifo.ALLOCATIONS;const dataset=await db.collection(datasetCollection).findOne({datasetId:entityId});if(!dataset)fail('SOURCE_REVIEW_NOT_FOUND','Candidate پیدا نشد.',404);const line=await db.collection(lineCollection).findOne(entityType==='purchase-dataset'?{datasetId:entityId,purchaseLineIdentity:lineIdentity}:{datasetId:entityId,saleLineId:lineIdentity});if(!line)fail('SOURCE_LINE_NOT_FOUND','ردیف مأخذ در Candidate پیدا نشد.',404);const sourceFingerprint=clean(line.sourceHash||dataset.sourceFingerprint||dataset.allocationFingerprint,128);const record={actionId:id('FSA'),entityType,entityId,lineIdentity,action,note:clean(input.note,1000),sourceFingerprint,actor:actor(by),createdAt:new Date(),immutable:true};await db.collection(ACTIONS).insertOne(record);return {ok:true,action:record};}

async function fifoFacts(db,datasetId){const allocations=await db.collection(fifo.ALLOCATIONS).find({datasetId}).toArray();const manuals=await db.collection(manualCost.COLLECTION).find({}).toArray();return fifo._provenanceFacts(allocations,manuals);}
function filterFacts(rows,filters={}){let out=rows;if(clean(filters.status))out=out.filter(row=>row.profitProvenanceStatus===clean(filters.status));if(clean(filters.invoice))out=out.filter(row=>String(row.saleInvoiceNumber||row.saleInvoiceNo||'').includes(clean(filters.invoice)));if(clean(filters.item))out=out.filter(row=>regex(filters.item).test(`${row.itemCode} ${row.itemGuid||''}`));if(clean(filters.seller))out=out.filter(row=>regex(filters.seller).test(`${row.sellerIdentity} ${row.sellerName||''}`));if(clean(filters.category))out=out.filter(row=>regex(filters.category).test(row.productCategory));return out;}
async function fifoLines(db,filters={},by={}){assertRole(by,READ_ROLES);const context=await contexts(db,filters),datasetId=clean(filters.fifoDatasetId||context.fifoCandidate?.datasetId||context.activeFifoId,100);if(!datasetId)return {ok:true,readOnly:true,datasetId:'',...paginate([],filters)};let rows=filterFacts(await fifoFacts(db,datasetId),filters);rows.sort((a,b)=>Number(b.saleInvoiceNumber||b.saleInvoiceNo||0)-Number(a.saleInvoiceNumber||a.saleInvoiceNo||0));return {ok:true,readOnly:true,datasetId,...paginate(rows,filters)};}
function factTotals(rows){const total={lines:rows.length,quantity:0,saleValue:0,fifoCost:0,fifoProfit:0};for(const row of rows){total.quantity+=numeric(row.quantityExact);total.saleValue+=numeric(row.saleValueExact);if(row.profitProvenanceStatus==='PROVEN'){total.fifoCost+=numeric(row.fifoCostExact);total.fifoProfit+=numeric(row.fifoProfitExact);}}return total;}
async function fifoSummary(db,filters={},by={}){assertRole(by,READ_ROLES);const context=await contexts(db,filters);const activeId=context.activeFifoId,candidateId=clean(filters.fifoDatasetId||context.fifoCandidate?.datasetId,100);const [oldFacts,newFacts]=await Promise.all([activeId?fifoFacts(db,activeId):[],candidateId?fifoFacts(db,candidateId):[]]);const split=rows=>Object.fromEntries(['PROVEN','PARTIAL','UNKNOWN'].map(status=>[status,factTotals(rows.filter(row=>row.profitProvenanceStatus===status))]));const oldMap=new Map(oldFacts.map(row=>[row.saleLineId,row])),newMap=new Map(newFacts.map(row=>[row.saleLineId,row]));const newlyProven=newFacts.filter(row=>row.profitProvenanceStatus==='PROVEN'&&oldMap.get(row.saleLineId)?.profitProvenanceStatus!=='PROVEN');const newlyUnknown=newFacts.filter(row=>row.profitProvenanceStatus==='UNKNOWN'&&oldMap.get(row.saleLineId)?.profitProvenanceStatus!=='UNKNOWN');const regressions=newFacts.filter(row=>oldMap.get(row.saleLineId)?.profitProvenanceStatus==='PROVEN'&&row.profitProvenanceStatus!=='PROVEN');const sourceDistribution={};for(const row of newFacts){const key=row.costSourceType||'UNKNOWN';if(!sourceDistribution[key])sourceDistribution[key]={sourceType:key,lines:0,saleValue:0,fifoCost:0,fifoProfit:0};const group=sourceDistribution[key];group.lines++;group.saleValue+=numeric(row.saleValueExact);group.fifoCost+=numeric(row.fifoCostExact);group.fifoProfit+=numeric(row.fifoProfitExact);}
  const aggregate=new Map();for(const row of newFacts){const key=`${row.sellerIdentity||'UNRESOLVED'}|${row.productCategory||'UNRESOLVED'}`,group=aggregate.get(key)||{sellerIdentity:row.sellerIdentity||'UNRESOLVED',productCategory:row.productCategory||'UNRESOLVED',totalSales:0,provenSales:0,unknownPartialSales:0,provenFifoProfit:0,totalLines:0,provenLines:0};group.totalLines++;group.totalSales+=numeric(row.saleValueExact);if(row.profitProvenanceStatus==='PROVEN'){group.provenLines++;group.provenSales+=numeric(row.saleValueExact);group.provenFifoProfit+=numeric(row.fifoProfitExact);}else group.unknownPartialSales+=numeric(row.saleValueExact);aggregate.set(key,group);}for(const group of aggregate.values())group.coverage=group.totalSales?group.provenSales*100/group.totalSales:0;
  return {ok:true,readOnly:true,activeDatasetId:activeId,candidateDatasetId:candidateId,active:split(oldFacts),candidate:split(newFacts),delta:{newlyProven:newlyProven.length,newlyUnknown:newlyUnknown.length,regressions:regressions.length,profitDelta:factTotals(newFacts).fifoProfit-factTotals(oldFacts).fifoProfit},sourceDistribution:Object.values(sourceDistribution),sellerCategorySummary:[...aggregate.values()].sort((a,b)=>b.totalSales-a.totalSales),labels:{profit:'سود FIFO با مأخذ اثبات‌شده',notTotalProfit:true}};
}

async function reviewCenter(db,filters={},by={}){assertRole(by,READ_ROLES);const context=await contexts(db,filters);const [reviews,manualPending,openingPending,mismatches]=await Promise.all([db.collection(REVIEWS).find({}).toArray(),count(db.collection(manualCost.COLLECTION),{status:'pending'}),count(db.collection(OPENING),{status:'pending'}),count(db.collection(ACTIONS),{action:'mismatch'})]);const openStates=new Set(['HUMAN_REVIEW','ACCOUNTING_APPROVED']),reviewByKey=new Map(reviews.map(row=>[`${row.entityType}|${row.entityId}`,row])),purchaseReview=reviewByKey.get(`purchase-dataset|${context.purchaseCandidate?.datasetId||''}`),fifoReview=reviewByKey.get(`fifo-dataset|${context.fifoCandidate?.datasetId||''}`),purchasePending=Boolean(context.purchaseCandidate)&&(!purchaseReview||openStates.has(purchaseReview.state)||['BUILT','VALIDATED'].includes(purchaseReview.state)),fifoPending=Boolean(context.fifoCandidate)&&(!fifoReview||openStates.has(fifoReview.state)||['BUILT','VALIDATED'].includes(fifoReview.state));return {ok:true,readOnly:true,queues:[{code:'PURCHASE_CANDIDATE_REVIEW',label:'بررسی کاندیدای منابع خرید',pendingCount:Number(purchasePending),financialExposure:null,oldestAt:purchaseReview?.createdAt||context.purchaseCandidate?.createdAt||null,responsibleRole:'accounting/admin'},{code:'MANUAL_COST_PENDING',label:'هزینه دستی در انتظار',pendingCount:manualPending,financialExposure:null,responsibleRole:'admin/manager'},{code:'OPENING_EVIDENCE_PENDING',label:'موجودی آغازین در انتظار',pendingCount:openingPending,financialExposure:null,responsibleRole:'admin/manager'},{code:'FIFO_CANDIDATE_REVIEW',label:'بررسی کاندیدای FIFO',pendingCount:Number(fifoPending),financialExposure:null,oldestAt:fifoReview?.createdAt||context.fifoCandidate?.createdAt||null,responsibleRole:'accounting/admin'},{code:'SOURCE_MISMATCH',label:'عدم تطابق مأخذ',pendingCount:mismatches,financialExposure:null,responsibleRole:'accounting'}]};}
async function activationPreview(db,entityType,entityId,by={}){assertRole(by,READ_ROLES);const context=await contexts(db,{}),summary=await fifoSummary(db,{fifoDatasetId:entityType==='fifo-dataset'?entityId:''},by);const current=entityType==='purchase-dataset'?datasetSummary(context.activePurchase,context.activePurchaseId):datasetSummary(context.activeFifo,context.activeFifoId),candidate=entityType==='purchase-dataset'?datasetSummary(await db.collection(purchase.DATASETS).findOne({datasetId:entityId}),context.activePurchaseId):datasetSummary(await db.collection(fifo.DATASETS).findOne({datasetId:entityId}),context.activeFifoId);if(!candidate)fail('ACTIVATION_PREVIEW_NOT_FOUND','کاندیدا پیدا نشد.',404);const review=await reviewFor(db,entityType,entityId,candidate.sourceFingerprint,candidate.validation?.valid?'VALIDATED':'BUILT');return {ok:true,readOnly:true,activationPerformed:false,activationEndpointAvailable:false,candidateId:entityId,currentActiveId:current?.datasetId||'',reviewState:review.state,sourceFingerprint:candidate.sourceFingerprint,financialExposure:entityType==='fifo-dataset'?summary.candidate?.UNKNOWN?.saleValue:null,coverageDelta:entityType==='fifo-dataset'?summary.delta:null,profitDelta:entityType==='fifo-dataset'?summary.delta?.profitDelta:null,exceptionDelta:entityType==='fifo-dataset'?(candidate.exceptions-(current?.exceptions||0)):null,gates:{candidateBuilt:Boolean(candidate),automatedValidationPass:Boolean(candidate.validation?.valid),accountingReview:review.state==='ACCOUNTING_APPROVED'||review.state==='ADMIN_APPROVED',adminApproval:review.state==='ADMIN_APPROVED',activationSeparatelyAuthorized:false}};}

module.exports={REVIEWS,ACTIONS,OPENING,REVIEW_STATES,GAP_BUCKETS,OPENING_STATES,READ_ROLES,LEGACY_WARNING,overview,purchaseDelta,sourceGaps,costEvidence,createOpeningDraft,updateOpeningDraft,transitionOpening,candidateReview,lineReview,fifoLines,fifoSummary,reviewCenter,activationPreview,_contexts:contexts,_gapBucket:gapBucket,_changeOf:changeOf,_openingHash:openingHash};
