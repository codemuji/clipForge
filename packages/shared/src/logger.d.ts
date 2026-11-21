export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
    ts: string;
    level: LogLevel;
    component: string;
    session_id: string;
    correlation_id: string;
    msg: string;
    [key: string]: unknown;
}
export declare class Logger {
    private component;
    private sessionId;
    constructor(component: string, sessionId?: string);
    setSessionId(sessionId: string): void;
    private write;
    debug(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry;
    info(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry;
    warn(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry;
    error(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry;
}
export declare function createLogger(component: string, sessionId?: string): Logger;
//# sourceMappingURL=logger.d.ts.map