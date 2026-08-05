'use strict';

const ALLOWED=Object.freeze(['BUSINESS','TEST','HISTORICAL','SYSTEM']);
const TEST_MARKER=/(?:TEST-CODEX|CODEX[-_ ]?STAGING[-_ ]?VALIDATION|STAGING[-_ ]?E2E|PHASE[-_ ]?5\.3\.1|TEMP(?:ORARY)?\b|\bTEST\b|GOVERNANCE[-_ ]?GATE)/i;
const SYSTEM_ACTOR=/^(?:system|phase-[a-z0-9-]+|migration|job[-_:])/i;
function clean(value,max=2000){return String(value==null?'':value).trim().slice(0,max);}
function recordText(row={}){return[row.batchId,row.adjustmentId,row.ledgerEntryId,row.policyVersionId,row.mappingId,row.rateVersionId,row.name,row.description,row.reason,row.reasonText,row.source,row.sourceType,row.sourceReference,row.createdBy?.username].map(value=>clean(value)).join(' | ');}
function classificationOf(recordType,row={},context={}){
  const testProvenance=TEST_MARKER.test(recordText(row))||TEST_MARKER.test(clean(context.policyName));
  const historicalProvenance=Boolean(row.historicalFrozen||row.policyVersionId==='LEGACY_PRE_POLICY'||row.status==='historical_frozen');
  const systemProvenance=Boolean(SYSTEM_ACTOR.test(clean(row.createdBy?.username))||row.systemGenerated===true);
  const explicit=clean(row.classification,20).toUpperCase();let classification='',classificationBasis='';
  if(ALLOWED.includes(explicit)){classification=explicit;classificationBasis='explicit-record-classification';}
  else if(historicalProvenance){classification='HISTORICAL';classificationBasis='immutable-legacy-policy-or-status';}
  else if(testProvenance){classification='TEST';classificationBasis='explicit-test-marker-in-record-or-policy';}
  else if(systemProvenance){classification='SYSTEM';classificationBasis='system-actor-or-system-generated-flag';}
  else{classification='BUSINESS';classificationBasis='authenticated-human-record-without-test-system-or-historical-marker';}
  const status=clean(row.status).toLowerCase();const affectsCurrentCalculations=(recordType==='policy'&&status==='approved')||(recordType==='mapping'&&status==='approved')||(recordType==='rate'&&status==='approved')||(recordType==='adjustment'&&status==='approved')||(recordType==='batch'&&status==='posted')||(recordType==='ledger');
  const open=!['cancelled','rejected','expired','reversed','retired','historical_frozen'].includes(status);const cleanupOrReversalRequired=classification==='TEST'&&(affectsCurrentCalculations||open);
  return{classification,classificationBasis,classificationReviewed:false,testProvenance,historicalProvenance,systemProvenance,affectsCurrentCalculations:Boolean(affectsCurrentCalculations),cleanupOrReversalRequired};
}
function decorate(recordType,row,context={}){return{...row,...classificationOf(recordType,row,context)};}
module.exports={ALLOWED,classificationOf,decorate};
