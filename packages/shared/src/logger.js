"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
exports.createLogger = createLogger;
class Logger {
    component;
    sessionId;
    constructor(component, sessionId = 'global') {
        this.component = component;
        this.sessionId = sessionId;
    }
    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }
    write(level, msg, correlationId, extra) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            component: this.component,
            session_id: this.sessionId,
            correlation_id: correlationId || this.sessionId,
            msg,
            ...extra
        };
        const line = JSON.stringify(entry);
        if (level === 'error') {
            process.stderr.write(line + '\n');
        }
        else {
            process.stdout.write(line + '\n');
        }
        return entry;
    }
    debug(msg, correlationId, extra) {
        return this.write('debug', msg, correlationId, extra);
    }
    info(msg, correlationId, extra) {
        return this.write('info', msg, correlationId, extra);
    }
    warn(msg, correlationId, extra) {
        return this.write('warn', msg, correlationId, extra);
    }
    error(msg, correlationId, extra) {
        return this.write('error', msg, correlationId, extra);
    }
}
exports.Logger = Logger;
function createLogger(component, sessionId) {
    return new Logger(component, sessionId);
}
//# sourceMappingURL=logger.js.map