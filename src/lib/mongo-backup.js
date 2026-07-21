const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const {config}=require('./config');

const history=[];
function databaseName(){try{return decodeURIComponent(new URL(config.mongoUri).pathname.replace(/^\//,'').split('?')[0])||'';}catch{return '';}}
function destinations(){return (config.mongoBackupAllowedRoots||[]).map((root,index)=>({id:String(index),label:root,root:path.resolve(root)}));}
function safeSubfolder(value=''){const v=String(value||'').trim();if(!v)return '';if(path.isAbsolute(v)||v.includes('..')||/[\0]/.test(v)||/^[\\/]{2}/.test(v))throw new Error('Invalid backup subfolder');if(!/^[\p{L}\p{N} _.-]+$/u.test(v))throw new Error('Invalid backup subfolder');return v;}
function resolveDestination(id,subfolder=''){const item=destinations().find(x=>x.id===String(id));if(!item)throw new Error('Invalid backup destination');const child=safeSubfolder(subfolder);const resolved=path.resolve(item.root,child);if(resolved!==item.root&&!resolved.startsWith(item.root+path.sep))throw new Error('Backup path escapes allowed root');return {...item,resolved};}
function stamp(d=new Date()){return d.toISOString().replace(/[-:]/g,'').replace('T','_').slice(0,15);}
async function sizeOf(dir){let total=0;for(const e of await fs.promises.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())total+=await sizeOf(p);else total+=(await fs.promises.stat(p)).size;}return total;}
async function run(request={}){const control=request.jobControl||{};const db=databaseName();if(!db)throw new Error('Database name cannot be resolved from MONGO_URI');const dest=resolveDestination(request.destinationId,request.subfolder);await fs.promises.mkdir(dest.resolved,{recursive:true});const folder=`MKCRM_${db}_${stamp()}_${Math.random().toString(16).slice(2,8)}`;const output=path.join(dest.resolved,folder);const rec={id:String(request.jobId||''),database:db,destinationId:dest.id,destination:dest.label,folder,status:'running',startedAt:new Date()};history.unshift(rec);control.progress?.({phase:'running',current:0,total:1,percent:20,message:'Running mongodump'});control.heartbeat?.();
  try{await new Promise((resolve,reject)=>{const child=spawn(config.mongoDumpBinary,['--uri',config.mongoUri,'--db',db,'--out',output],{shell:false,stdio:['ignore','ignore','pipe']});child.stderr.on('data',()=>control.heartbeat?.());child.on('error',e=>reject(e?.code==='ENOENT'?new Error('mongodump executable was not found'):new Error('mongodump could not start')));child.on('close',code=>code===0?resolve():reject(new Error(`mongodump failed with exit code ${code}`)));});const sizeBytes=await sizeOf(output);Object.assign(rec,{status:'completed',finishedAt:new Date(),durationMs:Date.now()-rec.startedAt.getTime(),sizeBytes});return {ok:true,...rec};}
  catch(e){Object.assign(rec,{status:'failed',finishedAt:new Date(),durationMs:Date.now()-rec.startedAt.getTime(),error:String(e.message||e).replace(config.mongoUri,'[redacted]')});throw e;}}
function status(){return {configured:destinations().length>0,database:databaseName(),destinations:destinations().map(({id,label})=>({id,label})),history:history.slice(0,20)};}
module.exports={run,status,destinations,resolveDestination,databaseName,_history:history};
