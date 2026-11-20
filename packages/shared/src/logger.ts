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

export class Logger {
  private component: string;
  private sessionId: string;

  constructor(component: string, sessionId: string = 'global') {
    this.component = component;
    this.sessionId = sessionId;
  }

  public setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  private write(level: LogLevel, msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = {
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
    } else {
      process.stdout.write(line + '\n');
    }
    return entry;
  }

  public debug(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry {
    return this.write('debug', msg, correlationId, extra);
  }

  public info(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry {
    return this.write('info', msg, correlationId, extra);
  }

  public warn(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry {
    return this.write('warn', msg, correlationId, extra);
  }

  public error(msg: string, correlationId?: string, extra?: Record<string, unknown>): LogEntry {
    return this.write('error', msg, correlationId, extra);
  }
}

export function createLogger(component: string, sessionId?: string): Logger {
  return new Logger(component, sessionId);
}
