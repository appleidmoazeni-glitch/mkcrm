"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobProgress = void 0;
/** Normalizes progress updates and derives a bounded percentage. */
class JobProgress {
    state = { phase: 'pending', current: 0, total: 0, percent: 0, message: '' };
    update(update) {
        const current = Math.max(0, update.current ?? this.state.current);
        const total = Math.max(0, update.total ?? this.state.total);
        const percent = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
        this.state = {
            phase: update.phase ?? this.state.phase,
            current,
            total,
            percent,
            message: update.message ?? this.state.message
        };
        return this.snapshot();
    }
    snapshot() { return { ...this.state }; }
}
exports.JobProgress = JobProgress;
