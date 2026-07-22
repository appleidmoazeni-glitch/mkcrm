"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopJobLogger = void 0;
/** Safe default used when the application has not configured a logger. */
class NoopJobLogger {
    log(level, message, context) {
        void level;
        void message;
        void context;
    }
    debug(message, context) { this.log('debug', message, context); }
    info(message, context) { this.log('info', message, context); }
    warn(message, context) { this.log('warn', message, context); }
    error(message, context) { this.log('error', message, context); }
}
exports.NoopJobLogger = NoopJobLogger;
