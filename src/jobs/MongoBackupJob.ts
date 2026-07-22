import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface MongoBackupResult extends Record<string, unknown> { readonly ok?:boolean; readonly sizeBytes?:number; }
export interface MongoBackupService { run(request:Record<string,unknown>):Promise<MongoBackupResult>; }
export interface MongoBackupJobInput { readonly request:Readonly<Record<string,unknown>>; readonly service:MongoBackupService; readonly onResult?:(result:MongoBackupResult)=>void|Promise<void>; }

/** Admin backup execution adapter. Destination validation and mongodump invocation live in the service. */
export class MongoBackupJob extends BackgroundJob {
  readonly name='mongo-backup'; readonly version=1;
  constructor(private readonly input:MongoBackupJobInput){super();}
  protected override async run(context:JobContext):Promise<void>{
    if(!this.input?.service)throw new JobEngineError(JobErrorCode.Internal,'Mongo backup job input is incomplete');
    const control={progress:(u:JobProgressUpdate)=>context.reportProgress(u),heartbeat:()=>context.heartbeatNow(),checkCancellation:()=>context.cancellationToken.throwIfCancellationRequested()};
    context.reportProgress({phase:'preparing',current:0,total:1,percent:5,message:'Validating backup destination'});control.checkCancellation();
    const result=await this.input.service.run({...this.input.request,jobControl:control});await this.input.onResult?.(result);
    context.metrics.setCounter('backupSizeBytes',Number(result.sizeBytes||0));
    if(result.ok===false)throw new JobEngineError(JobErrorCode.Failed,String(result.error||'Mongo backup failed'));
    context.reportProgress({phase:'completed',current:1,total:1,percent:100,message:'Mongo backup completed'});
  }
}
