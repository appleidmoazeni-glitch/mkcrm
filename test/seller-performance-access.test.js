'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveSellerScope}=require('../src/lib/seller-performance-access');
const saleSnapshot=require('../src/lib/sale-snapshot');
const normalize=saleSnapshot._normalizeSellerAccountNumber;

test('seller and seller-buyer roles are restricted to their normalized own AccountNumber',()=>{
  for(const role of ['seller','seller_buyer']){
    const own=resolveSellerScope({role,requestedSeller:' ۱۱۷ ',ownSeller:'117',normalize});
    assert.equal(own.ok,true);
    assert.equal(own.sellerAccountNumber,'117');
    assert.equal(own.scope,'own-seller-only');
    const forbidden=resolveSellerScope({role,requestedSeller:'118',ownSeller:'117',normalize});
    assert.equal(forbidden.ok,false);
    assert.equal(forbidden.code,'SELLER_SCOPE_FORBIDDEN');
  }
});

test('seller without an authoritative mapping is rejected',()=>{
  const result=resolveSellerScope({role:'seller',requestedSeller:'',ownSeller:'',normalize});
  assert.equal(result.ok,false);
  assert.equal(result.code,'SELLER_MAPPING_REQUIRED');
});

test('manager, supervisor, accounting, purchase and admin retain authorized seller scope',()=>{
  for(const role of ['manager','supervisor','accounting','purchase','admin']){
    const result=resolveSellerScope({role,requestedSeller:' ۱۱۷ ',normalize});
    assert.equal(result.ok,true);
    assert.equal(result.sellerAccountNumber,'117');
    assert.equal(result.scope,'authorized-sellers');
  }
});

test('unapproved roles cannot read Seller Performance',()=>{
  const result=resolveSellerScope({role:'warehouse',requestedSeller:'117',normalize});
  assert.equal(result.ok,false);
  assert.equal(result.code,'SELLER_PERFORMANCE_FORBIDDEN');
});
