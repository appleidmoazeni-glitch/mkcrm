'use strict';

function valueAt(doc, path) {
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], doc);
}
function same(a, b) {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return a === b;
}
function matchesValue(value, expected) {
  if (expected instanceof RegExp) return expected.test(String(value ?? ''));
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || expected instanceof Date) return same(value, expected);
  if ('$exists' in expected && (value !== undefined) !== Boolean(expected.$exists)) return false;
  if ('$ne' in expected && same(value, expected.$ne)) return false;
  if ('$in' in expected && !expected.$in.some(item => same(value, item))) return false;
  if ('$nin' in expected && expected.$nin.some(item => same(value, item))) return false;
  if ('$gte' in expected && value < expected.$gte) return false;
  if ('$lte' in expected && value > expected.$lte) return false;
  if ('$regex' in expected && !new RegExp(expected.$regex, expected.$options || '').test(String(value ?? ''))) return false;
  return true;
}
function matches(doc, query = {}) {
  if (query.$or && !query.$or.some(part => matches(doc, part))) return false;
  return Object.entries(query).every(([key, expected]) => key === '$or' || matchesValue(valueAt(doc, key), expected));
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
  async updateOne(filter, update, options={}) {
    const index=this.rows.findIndex(row=>matches(row,filter));
    if(index>=0) {
      if(update.$set)Object.assign(this.rows[index],structuredClone(update.$set));
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
  async createIndex(key, options={}) { const name=options.name||Object.entries(key).map(([k,v])=>`${k}_${v}`).join('_'); if(!this.indexList.some(x=>x.name===name))this.indexList.push({name,key,...options}); return name; }
  async indexes() { return structuredClone(this.indexList); }
  async dropIndex(name) { this.indexList=this.indexList.filter(index=>index.name!==name); }
  async estimatedDocumentCount() { return this.rows.length; }
}
class MemoryDb {
  constructor(seed={}) { this.collections=new Map(Object.entries(seed).map(([name,rows])=>[name,new MemoryCollection(name,rows)])); }
  collection(name) { if(!this.collections.has(name))this.collections.set(name,new MemoryCollection(name)); return this.collections.get(name); }
  listCollections() { return {toArray:async()=>[...this.collections.keys()].map(name=>({name}))}; }
  async createCollection(name) { return this.collection(name); }
}

module.exports={MemoryDb};
