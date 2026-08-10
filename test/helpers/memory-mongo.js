'use strict';
const { Decimal128 } = require('mongodb');

function valueAt(doc, path) {
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], doc);
}
function setAt(doc,path,value){
  const keys=String(path).split('.');let target=doc;
  for(const key of keys.slice(0,-1)){if(!target[key]||typeof target[key]!=='object')target[key]={};target=target[key];}
  target[keys.at(-1)]=value;
}
function unsetAt(doc,path){
  const keys=String(path).split('.');let target=doc;
  for(const key of keys.slice(0,-1)){target=target?.[key];if(!target)return;}
  delete target[keys.at(-1)];
}
function same(a, b) {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return a === b;
}
function numberValue(value){if(value&&value.bytes instanceof Uint8Array&&value.bytes.length===16){try{return Number(new Decimal128(value.bytes).toString());}catch{}}return Number(value||0);}
function matchesValue(value, expected) {
  if (expected instanceof RegExp) return expected.test(String(value ?? ''));
  if (Array.isArray(value) && (!expected || typeof expected !== 'object' || Array.isArray(expected) || expected instanceof Date)) return value.some(item => same(item, expected));
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || expected instanceof Date) return same(value, expected);
  if ('$exists' in expected && (value !== undefined) !== Boolean(expected.$exists)) return false;
  if ('$ne' in expected && same(value, expected.$ne)) return false;
  if ('$in' in expected && !expected.$in.some(item => same(value, item))) return false;
  if ('$nin' in expected && expected.$nin.some(item => same(value, item))) return false;
  if ('$gte' in expected && numberValue(value) < numberValue(expected.$gte)) return false;
  if ('$lte' in expected && numberValue(value) > numberValue(expected.$lte)) return false;
  if ('$gt' in expected && numberValue(value) <= numberValue(expected.$gt)) return false;
  if ('$lt' in expected && numberValue(value) >= numberValue(expected.$lt)) return false;
  if ('$regex' in expected && !new RegExp(expected.$regex, expected.$options || '').test(String(value ?? ''))) return false;
  return true;
}
function matches(doc, query = {}) {
  if (query.$or && !query.$or.some(part => matches(doc, part))) return false;
  if (query.$and && !query.$and.every(part => matches(doc, part))) return false;
  return Object.entries(query).every(([key, expected]) => ['$or','$and'].includes(key) || matchesValue(valueAt(doc, key), expected));
}
function compareBy(spec) {
  return (a, b) => {
    for (const [key, direction] of Object.entries(spec || {})) {
      const av=valueAt(a,key), bv=valueAt(b,key);
      if (av < bv) return -1 * Number(direction);
      if (av > bv) return 1 * Number(direction);
    }
    return 0;
  };
}
class Cursor {
  constructor(rows) { this.rows=rows; }
  sort(spec) { this.rows.sort(compareBy(spec)); return this; }
  limit(count) { this.rows=this.rows.slice(0,Math.max(0,Number(count))); return this; }
  project() { return this; }
  skip(count) { this.rows=this.rows.slice(Number(count)||0); return this; }
  async toArray() { return this.rows.map(row => structuredClone(row)); }
}
class MemoryCollection {
  constructor(name, rows=[]) { this.name=name; this.rows=rows.map(row=>structuredClone(row)); this.indexList=[{name:'_id_',key:{_id:1},unique:true}]; }
  find(query={}) { return new Cursor(this.rows.filter(row=>matches(row,query))); }
  async findOne(query={}, options={}) {
    const rows=this.rows.filter(row=>matches(row,query));
    if(options.sort) rows.sort(compareBy(options.sort));
    return rows.length ? structuredClone(rows[0]) : null;
  }
  async insertOne(doc) { const value=structuredClone(doc); if(value._id==null)value._id=`${this.name}-${this.rows.length+1}`; this.rows.push(value); return {acknowledged:true,insertedId:value._id}; }
  async insertMany(docs) { for(const doc of docs)await this.insertOne(doc); return {acknowledged:true,insertedCount:docs.length}; }
  async countDocuments(query={}) { return this.rows.filter(row=>matches(row,query)).length; }
  async updateOne(filter, update, options={}) {
    const index=this.rows.findIndex(row=>matches(row,filter));
    if(index>=0) {
      if(update.$set)for(const [path,value] of Object.entries(structuredClone(update.$set)))setAt(this.rows[index],path,value);
      if(update.$inc)for(const [path,value] of Object.entries(update.$inc))setAt(this.rows[index],path,Number(valueAt(this.rows[index],path)||0)+Number(value||0));
      if(update.$unset)for(const path of Object.keys(update.$unset))unsetAt(this.rows[index],path);
      if(update.$push)for(const [path,spec] of Object.entries(structuredClone(update.$push))){
        const current=Array.isArray(valueAt(this.rows[index],path))?valueAt(this.rows[index],path):[];
        const additions=spec&&typeof spec==='object'&&Array.isArray(spec.$each)?spec.$each:[spec];
        let next=[...current,...additions];
        if(spec&&typeof spec==='object'&&Number(spec.$slice)<0)next=next.slice(Number(spec.$slice));
        setAt(this.rows[index],path,next);
      }
      return {acknowledged:true,matchedCount:1,modifiedCount:1,upsertedCount:0};
    }
    if(!options.upsert)return {acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:0};
    const doc={...structuredClone(filter),...(update.$setOnInsert?structuredClone(update.$setOnInsert):{}),...(update.$set?structuredClone(update.$set):{})};
    delete doc.$or;
    if(doc._id==null)doc._id=`${this.name}-${this.rows.length+1}`;
    this.rows.push(doc);
    return {acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:1,upsertedId:doc._id};
  }
  async deleteMany(query={}) { const before=this.rows.length; this.rows=this.rows.filter(row=>!matches(row,query)); return {acknowledged:true,deletedCount:before-this.rows.length}; }
  async updateMany(filter,update,options={}) { let matchedCount=0,modifiedCount=0;for(const row of this.rows.filter(item=>matches(item,filter))){matchedCount++;if(update.$set)for(const [path,value] of Object.entries(structuredClone(update.$set)))setAt(row,path,value);if(update.$unset)for(const path of Object.keys(update.$unset))unsetAt(row,path);modifiedCount++;}if(!matchedCount&&options.upsert){await this.updateOne(filter,update,{upsert:true});return{acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:1};}return{acknowledged:true,matchedCount,modifiedCount,upsertedCount:0}; }
  async bulkWrite(operations) { let modifiedCount=0,upsertedCount=0;for(const operation of operations){if(operation.updateOne){const result=await this.updateOne(operation.updateOne.filter,operation.updateOne.update,{upsert:operation.updateOne.upsert});modifiedCount+=result.modifiedCount||0;upsertedCount+=result.upsertedCount||0;}}return{acknowledged:true,modifiedCount,upsertedCount}; }
  async createIndex(key, options={}) { const name=options.name||Object.entries(key).map(([k,v])=>`${k}_${v}`).join('_'); if(!this.indexList.some(x=>x.name===name))this.indexList.push({name,key,...options}); return name; }
  async indexes() { return structuredClone(this.indexList); }
  async dropIndex(name) { this.indexList=this.indexList.filter(index=>index.name!==name); }
  async estimatedDocumentCount() { return this.rows.length; }
  aggregate(pipeline=[]){
    let rows=this.rows.map(row=>structuredClone(row));
    for(const stage of pipeline){
      if(stage.$match)rows=rows.filter(row=>matches(row,stage.$match));
      else if(stage.$group){
        const groups=new Map();
        for(const row of rows){
          const resolve=value=>{if(typeof value==='string'&&value.startsWith('$'))return valueAt(row,value.slice(1));if(Array.isArray(value))return value.map(resolve);if(value&&typeof value==='object'){if(value.$size!=null)return (resolve(value.$size)||[]).length;if(value.$gt)return resolve(value.$gt[0])>resolve(value.$gt[1]);if(value.$ne)return resolve(value.$ne[0])!==resolve(value.$ne[1]);if(value.$cond)return resolve(value.$cond[0])?resolve(value.$cond[1]):resolve(value.$cond[2]);}return value;};
          const id=stage.$group._id&&typeof stage.$group._id==='object'&&!Array.isArray(stage.$group._id)
            ?Object.fromEntries(Object.entries(stage.$group._id).map(([key,value])=>[key,resolve(value)]))
            :resolve(stage.$group._id);
          const marker=JSON.stringify(id);const group=groups.get(marker)||{_id:id};
          for(const [key,spec] of Object.entries(stage.$group)){if(key==='_id')continue;if(spec.$sum!=null)group[key]=numberValue(group[key])+numberValue(resolve(spec.$sum));else if(spec.$first!=null&&group[key]===undefined)group[key]=resolve(spec.$first);else if(spec.$addToSet!=null){const value=resolve(spec.$addToSet);const list=group[key]||[];if(!list.some(item=>same(item,value)))list.push(value);group[key]=list;}}
          groups.set(marker,group);
        }
        rows=[...groups.values()];
      }else if(stage.$sort)rows.sort(compareBy(stage.$sort));
      else if(stage.$skip)rows=rows.slice(Number(stage.$skip));
      else if(stage.$limit)rows=rows.slice(0,Number(stage.$limit));
      else if(stage.$count)rows=rows.length?[{[stage.$count]:rows.length}]:[];
    }
    return new Cursor(rows);
  }
}
class MemoryDb {
  constructor(seed={}) { this.collections=new Map(Object.entries(seed).map(([name,rows])=>[name,new MemoryCollection(name,rows)])); }
  collection(name) { if(!this.collections.has(name))this.collections.set(name,new MemoryCollection(name)); return this.collections.get(name); }
  listCollections() { return {toArray:async()=>[...this.collections.keys()].map(name=>({name}))}; }
  async createCollection(name) { return this.collection(name); }
}

module.exports={MemoryDb};
