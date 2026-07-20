"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobEventEmitter = void 0;
/** Small synchronous event bus. Listener failures are isolated from the engine. */
class JobEventEmitter {
    listeners = new Map();
    on(event, listener) {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return () => this.off(event, listener);
    }
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
    }
    emit(event, payload) {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            try {
                listener(payload);
            }
            catch { /* Event consumers cannot fail a job. */ }
        }
    }
    removeAllListeners() { this.listeners.clear(); }
}
exports.JobEventEmitter = JobEventEmitter;
