'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveBase}=require('../scripts/test-all');

test('runtime smoke harness has no implicit target',()=>{
  assert.throws(()=>resolveBase({}),/MKCRM_TEST_BASE_URL is required/);
});
test('runtime smoke harness always rejects Production port 1385',()=>{
  assert.throws(()=>resolveBase({MKCRM_TEST_BASE_URL:'http://127.0.0.1:1385',MKCRM_TEST_TARGET:'staging'}),/Production port 1385 is forbidden/);
});
test('Staging port 1386 requires explicit staging intent',()=>{
  assert.throws(()=>resolveBase({MKCRM_TEST_BASE_URL:'http://127.0.0.1:1386'}),/MKCRM_TEST_TARGET=staging/);
  assert.equal(resolveBase({MKCRM_TEST_BASE_URL:'http://127.0.0.1:1386',MKCRM_TEST_TARGET:'staging'}),'http://127.0.0.1:1386');
});
test('explicit local non-production server is accepted',()=>{
  assert.equal(resolveBase({MKCRM_TEST_BASE_URL:'http://localhost:18000',MKCRM_TEST_TARGET:'local'}),'http://localhost:18000');
});
