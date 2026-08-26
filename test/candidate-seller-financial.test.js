'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('Candidate Seller Financial UI is Persian-first, candidate-scoped and exposes required filters',()=>{
  const ui=read('public/assets/app.js');
  const phase=ui.slice(ui.indexOf('/* Candidate Seller Financial consumer'));
  for(const contract of ['CANDIDATE / NON-ACTIVE / NON-PAYROLL','فروش ناخالص','برگشت از فروش','فروش خالص مالی','سود FIFO اثبات‌شده','پوشش مبلغ فروش','Product Category رسمی','csfSeller','csfCategory','csfItem','csfInvoice','csfProvenance','csfSupplier','csfSaleMin','csfProfitMin','csfMarginMin'])assert.match(phase,new RegExp(contract));
  assert.match(phase,/runId:q\('#csfRun'\)/);assert.match(phase,/requestGeneration|generation/);assert.match(phase,/current!==generation/);assert.match(phase,/current!==drillGeneration/);
  assert.match(phase,/seller-financial-performance\/category-totals/);assert.doesNotMatch(phase,/csfRun'\)\.onchange=\(\)=>render/);
});

test('Candidate financial build route materializes canonical FIFO facts and never activates FIFO or payroll',()=>{
  const server=read('src/server.js'),service=read('src/lib/seller-financial-performance.js');
  assert.match(server,/sellerFinancialPrefix}\/candidate-build/);assert.match(server,/materializeFifoProfitFacts\(db,\{fifoDatasetId,candidateOnly:true\}/);
  assert.match(service,/if\(candidateOnly\).*Seller Financial Candidate is ready for human validation/);
  assert.match(service,/active:false,candidateOnly:true,activationStatus:'validated-candidate'/);
  for(const forbidden of ['Invoice/Put','PutSaleInvoice','PutBuyInvoice','itemInventoryCatalog.update','supplierPurchaseLayers.update'])assert.equal(service.includes(forbidden),false,forbidden);
});

test('Candidate facts preserve return linkage and unknown profit remains null',()=>{
  const ledger=read('src/lib/profit-commission-ledger.js');
  for(const field of ['profitFactsDatasetId','returnLinkage','originSaleInvoiceNumber','originSaleLineIdentity','reversedCostExact','restoredAllocationId'])assert.match(ledger,new RegExp(field));
  assert.match(ledger,/actualFifoProfitExact = provenance\.profitProvenanceStatus==='PROVEN'.*:\s*null/);
});
