export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type JobLogContext = Readonly<Record<string, unknown>>;

/** Logging boundary; storage and transports can be supplied later. */
export interface JobLogger {
  log(level: JobLogLevel, message: string, context?: JobLogContext): void;
  debug(message: string, context?: JobLogContext): void;
  info(message: string, context?: JobLogContext): void;
  warn(message: string, context?: JobLogContext): void;
  error(message: string, context?: JobLogContext): void;
}

/** Safe default used when the application has not configured a logger. */
export class NoopJobLogger implements JobLogger {
  log(level: JobLogLevel, message: string, context?: JobLogContext): void {
    void level; void message; void context;
  }
  debug(message: string, context?: JobLogContext): void { this.log('debug', message, context); }
  info(message: string, context?: JobLogContext): void { this.log('info', message, context); }
  warn(message: string, context?: JobLogContext): void { this.log('warn', message, context); }
  error(message: string, context?: JobLogContext): void { this.log('error', message, context); }
}
