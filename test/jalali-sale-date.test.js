'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const shaygan=require('../src/lib/shaygan');
const saleSnapshot=require('../src/lib/sale-snapshot');
const {
  normalizeJalaliDate,
  normalizeJalaliRange,
  canonicalSaleDate
}=require('../src/lib/jalali-date');

test('Seller Performance Jalali input normalizes Persian and English digits with supported separators',()=>{
  assert.equal(normalizeJalaliDate('۱۴۰۵/۰۵/۰۱',{required:true}),'14050501');
  assert.equal(normalizeJalaliDate('1405/05/01',{required:true}),'14050501');
  assert.equal(normalizeJalaliDate('1405-05-01',{required:true}),'14050501');
  assert.equal(normalizeJalaliDate('14050501',{required:true}),'14050501');
});

test('incomplete, Gregorian, malformed, and reversed Seller Performance dates fail transparently',()=>{
  for(const value of ['1405/05','140505','20260728','1405/13/01','1405/05/32']){
    assert.throws(
      ()=>normalizeJalaliDate(value,{field:'dateFrom',required:true}),
      error=>error.code==='INVALID_JALALI_DATE'&&error.statusCode===400&&error.field==='dateFrom'
    );
  }
  assert.throws(
    ()=>normalizeJalaliRange({dateFrom:'14050506',dateTo:'14050101'}),
    error=>error.code==='INVALID_JALALI_DATE_RANGE'&&error.statusCode===400
  );
});

test('Gregorian Invoice/Get response dates become canonical Jalali sale dates without changing Jalali inputs',()=>{
  assert.equal(canonicalSaleDate('2026-03-25'),'14050105');
  assert.equal(canonicalSaleDate('2026-07-28'),'14050506');
  assert.equal(canonicalSaleDate('1405/05/01'),'14050501');
});

test('Sale Snapshot sends canonical Jalali range to Shaygan and stores response date as Jalali',async t=>{
  const original=shaygan.getInvoicePageByTypeNumberRange;
  t.after(()=>{shaygan.getInvoicePageByTypeNumberRange=original;});
  const calls=[];
  shaygan.getInvoicePageByTypeNumberRange=async(rowStart,invType,invNoFrom,invNoTo,dateFrom,dateTo)=>{
    calls.push({rowStart,invType,invNoFrom,invNoTo,dateFrom,dateTo});
    return {
      ok:true,
      result:rowStart===0?[{
        InvTyp:2,
        InvNo:5029,
        InvDate:'2026-07-28',
        SAccountNumber:'117',
        AccountNumber:'110',
        Body:[{ItemCode:'A',Quan:1,Price:100,Amount:100}]
      }]:[]
    };
  };
  const db=new MemoryDb({
    userShayganMappings:[{username:'seller',employeeAccountNumber:'117',cashboxAccountNumber:'110'}],
    itemInventoryCatalog:[{itemCode:'A',raw:{ItemCode:'A',MainGroupCode:'10',MainGroupName:'CPU'}}]
  });
  const result=await saleSnapshot.buildSaleSnapshot(db,{
    mode:'full',
    dateFrom:'۱۴۰۵/۰۵/۰۱',
    dateTo:'1405-05-06',
    pageSize:20,
    maxPages:2
  });
  assert.equal(result.ok,true);
  assert.ok(calls.length>=2);
  assert.ok(calls.every(call=>call.dateFrom==='14050501'&&call.dateTo==='14050506'));
  assert.equal(db.collection('saleSnapshotDatasetHeaders').rows[0].invDate,'14050506');
  assert.equal(db.collection('saleSnapshotDatasetHeaders').rows[0].invDateRaw,'2026-07-28');
  assert.equal(db.collection('saleSnapshotDatasetLines').rows[0].saleDate,'14050506');
});

test('14050101 through 14050506 returns matching real-range Snapshot rows including legacy Gregorian storage',async()=>{
  const db=new MemoryDb({
    saleInvoiceLines:[
      {saleInvoiceType:2,saleInvoiceNo:1,row:1,saleDate:'2026-03-25',sellerAccountNumber:'117',itemCode:'A',qty:1,saleValue:100},
      {saleInvoiceType:2,saleInvoiceNo:2,row:1,saleDate:'14050501',sellerAccountNumber:'117',itemCode:'B',qty:1,saleValue:200},
      {saleInvoiceType:2,saleInvoiceNo:3,row:1,saleDate:'2026-07-28',sellerAccountNumber:'117',itemCode:'C',qty:1,saleValue:300},
      {saleInvoiceType:2,saleInvoiceNo:4,row:1,saleDate:'2026-07-29',sellerAccountNumber:'117',itemCode:'D',qty:1,saleValue:400}
    ]
  });
  const report=await saleSnapshot.sellerPerformance(db,{
    sellerAccountNumber:'117',
    dateFrom:'14050101',
    dateTo:'14050506'
  });
  assert.equal(report.invoiceCount,3);
  assert.equal(report.lineCount,3);
  assert.equal(report.totalSales,600);
  assert.deepEqual(report.lines.map(line=>line.saleDate),['14050105','14050501','14050506']);
});

test('Seller Performance rejects invalid non-empty date instead of returning a misleading zero result',async()=>{
  const db=new MemoryDb({saleInvoiceLines:[]});
  await assert.rejects(
    ()=>saleSnapshot.sellerPerformance(db,{dateFrom:'1405/05',dateTo:'14050506'}),
    error=>error.code==='INVALID_JALALI_DATE'&&error.statusCode===400
  );
});

test('Seller Performance path contains no Jalali-to-Gregorian conversion and UI sends normalized values',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  const snapshot=fs.readFileSync(path.join(__dirname,'../src/lib/sale-snapshot.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const reportPath=server.slice(server.indexOf('function normalizeSellerPerformanceQuery'),server.indexOf('function canViewPurchaseInvoicesUser'));
  assert.doesNotMatch(reportPath,/jalaliToGregorian/i);
  assert.doesNotMatch(snapshot,/jalaliToGregorian/i);
  assert.match(app,/normalizeSellerPerformanceJalaliDate\(\$\('#spFrom'\)/);
  assert.match(app,/set\('dateFrom',dateFrom\)/);
});
