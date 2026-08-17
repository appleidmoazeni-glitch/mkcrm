#!/usr/bin/env node
'use strict';

const {connectMongo,closeMongo}=require('../src/lib/mongo');
const manualCost=require('../src/lib/manual-cost-resolution');
const shaygan=require('../src/lib/shaygan');
const openingBasis=require('../src/lib/opening-accounting-cost-basis');

function option(name,fallback=''){const prefix=`--${name}=`;const value=process.argv.slice(2).find(argument=>argument.startsWith(prefix));return value?value.slice(prefix.length):fallback;}
async function main(){
  const maxItems=Math.max(1,Math.min(Number(option('max-items','15')),25));
  const timeoutMs=Math.max(500,Math.min(Number(option('timeout-ms','4000')),5000));
  const db=await connectMongo();
  if(!/staging/i.test(db.databaseName))throw new Error(`Refusing non-staging database: ${db.databaseName}`);
  const report=await manualCost.cleanCaseCandidates(db,{sort:'saleAmount',direction:'desc'});
  const checked=[],noBasis=[];let selected=null;
  for(const row of report.list.slice(0,maxItems)){
    const result=await shaygan.getKardexByItemCode(row.itemCode,'',{maxRows:100,hardMaxRows:100,timeoutMs}).catch(error=>({ok:false,error:String(error.message||error).slice(0,300)}));
    const evidence=openingBasis.fromKardex(result,new Date());
    const item={itemCode:row.itemCode,itemGuid:row.itemGuid,itemDescription:row.itemDescription,productCategory:row.category,unresolvedQuantity:row.saleQuantity,affectedSaleLines:row.saleLineCount,saleValueExposure:row.saleAmount,affectedSellers:row.affectedSellers,firstAffectedSaleDate:row.firstSaleDate,sourceClass:evidence?'OPENING_ACCOUNTING_COST':'NO_VALID_COST_BASIS',suggestedUnitCostExact:evidence?.openingUnitCostExact||null,evidenceQuantityCapacityExact:evidence?.openingQuantityExact||null,evidenceDate:evidence?.effectiveOpeningDate||null,evidenceFingerprint:evidence?.sourceFingerprint||null,priorManualCost:false,openingInventoryEvidence:false};
    checked.push(item);if(evidence){selected=item;break;}noBasis.push(item);
  }
  process.stdout.write(`${JSON.stringify({ok:true,readOnly:true,mongoWrites:0,shayganWrites:0,activeSnapshotId:report.activeSnapshotId,activePurchaseLayerDatasetId:report.activePurchaseLayerDatasetId,cleanCandidateCount:report.total,checkedCount:checked.length,selectedOpeningCase:selected,selectedNoValidCostCase:noBasis[0]||null,checked},null,2)}\n`);
}
main().catch(error=>{process.stderr.write(`${JSON.stringify({ok:false,error:String(error.message||error).slice(0,1000)})}\n`);process.exitCode=1;}).finally(closeMongo);
