import fs from 'node:fs';
import { createLogger, Logger } from '@clipforge/shared';
import type { SamplerChatCounts, SignalChat } from '@clipforge/shared';
import type { ChatCountProvider } from '../sampler/types.js';
import type {
  ChatAdapterConfig,
  EphemeralChatEvent,
  ChatWindowStats
} from './types.js';

const CHAT_LOG_LINE_REGEX = /^\[(\d+(?:\.\d+)?)\]\s*([^:]+):\s*(.*)$/;
const JSON_LINE_REGEX = /^\{.*\}$/;

export class ChatSignalAdapter implements ChatCountProvider {
  public readonly config: Required<ChatAdapterConfig>;
  private readonly logger: Logger;
  private readonly events: EphemeralChatEvent[] = [];
  private readonly ephemeralUserMap: Map<string, number> = new Map();
  private nextChatterId: number = 1;
  private droppedEventsCount: number = 0;

  constructor(
    config: ChatAdapterConfig = {},
    sessionId: string = 'global',
    logger?: Logger
  ) {
    this.config = {
      enabled: config.enabled ?? false,
      platform: config.platform ?? 'none',
      channel: config.channel ?? '',
      baselineVelocity: config.baselineVelocity ?? 5.0,
      baselineWindowSeconds: config.baselineWindowSeconds ?? 120.0,
      maxEventsPerMinute: config.maxEventsPerMinute ?? 600
    };

    this.logger = logger || createLogger('chat-adapter', sessionId);
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Ingests a single chat event at timestamp t.
   * Strips all raw message text and viewer identities per AGENTS.md §10.
   * Maintains only an ephemeral numeric chatter identifier and timestamp in memory.
   */
  public recordEvent(t: number, rawUserIdentifier?: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    // Rate-limiting check: count events in the trailing 60s
    const minuteCutoff = Math.max(0, t - 60.0);
    let recentCount = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].t >= minuteCutoff) {
        recentCount++;
      } else {
        break;
      }
    }

    if (recentCount >= this.config.maxEventsPerMinute) {
      this.droppedEventsCount++;
      if (this.droppedEventsCount % 10 === 1) {
        this.logger.warn('Chat event rate limit exceeded; dropping events', undefined, {
          rate_limit_per_min: this.config.maxEventsPerMinute,
          total_dropped: this.droppedEventsCount
        });
      }
      return false;
    }

    // Ephemeral anonymization: map username string to integer index
    let chatterId = 0;
    if (rawUserIdentifier) {
      const existing = this.ephemeralUserMap.get(rawUserIdentifier);
      if (existing !== undefined) {
        chatterId = existing;
      } else {
        chatterId = this.nextChatterId++;
        this.ephemeralUserMap.set(rawUserIdentifier, chatterId);
      }
    }

    this.events.push({ t, chatterId });

    // Evict events older than baselineWindowSeconds
    this.pruneOldEvents(t);
    return true;
  }

  /**
   * Loads and parses chat events from a fixture log file.
   * Discards all raw message content and user PII immediately.
   */
  public loadFixtureLog(filePath: string): number {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Chat fixture log file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return this.parseLogContent(content);
  }

  /**
   * Parses chat log content string line-by-line.
   * Supports standard format: `[t_seconds] username: message` or JSON Lines `{ t: 12.5, user: "..." }`.
   */
  public parseLogContent(content: string): number {
    const lines = content.split(/\r?\n/);
    let ingestedCount = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      // 1. Try standard [t_seconds] username: message format
      const match = line.match(CHAT_LOG_LINE_REGEX);
      if (match) {
        const t = parseFloat(match[1]);
        const user = match[2].trim();
        // Discard match[3] (raw message text) immediately
        if (!isNaN(t)) {
          this.recordEvent(t, user);
          ingestedCount++;
          continue;
        }
      }

      // 2. Try JSON line format
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const parsed = JSON.parse(line);
          const t = typeof parsed.t === 'number' ? parsed.t : parseFloat(parsed.timestamp);
          const user = typeof parsed.user === 'string' ? parsed.user : undefined;
          if (!isNaN(t)) {
            this.recordEvent(t, user);
            ingestedCount++;
            continue;
          }
        } catch {
          // Ignore invalid JSON line
        }
      }
    }

    return ingestedCount;
  }

  /**
   * Returns aggregate chat metrics for a given window [windowStartT, windowEndT].
   * Implements ChatCountProvider for StreamSampler.
   */
  public getCounts(windowStartT: number, windowEndT: number): SamplerChatCounts {
    if (!this.config.enabled) {
      return { messages_in_window: 0, unique_chatters: 0 };
    }

    const stats = this.getWindowStats(windowStartT, windowEndT);
    return {
      messages_in_window: stats.messages_in_window,
      unique_chatters: stats.unique_chatters
    };
  }

  /**
   * Calculates detailed stats (counts and velocity) for a window.
   */
  public getWindowStats(windowStartT: number, windowEndT: number): ChatWindowStats {
    const duration = Math.max(0.1, windowEndT - windowStartT);

    if (!this.config.enabled) {
      return {
        windowStartT,
        windowEndT,
        durationSeconds: duration,
        messages_in_window: 0,
        unique_chatters: 0,
        velocity: 0
      };
    }

    const chatters = new Set<number>();
    let messages = 0;

    for (const event of this.events) {
      if (event.t >= windowStartT && event.t <= windowEndT) {
        messages++;
        if (event.chatterId > 0) {
          chatters.add(event.chatterId);
        }
      }
    }

    const velocity = messages / duration;

    return {
      windowStartT,
      windowEndT,
      durationSeconds: duration,
      messages_in_window: messages,
      unique_chatters: chatters.size,
      velocity: Number(velocity.toFixed(2))
    };
  }

  /**
   * Computes the normalized chat signal value in [0, 1] for the Scorer.
   * When adapter is disabled, returns { value: null } per CONTRACTS.md §3.
   */
  public computeSignal(windowStartT: number, windowEndT: number): SignalChat {
    if (!this.config.enabled) {
      return { value: null };
    }

    const stats = this.getWindowStats(windowStartT, windowEndT);
    if (stats.messages_in_window === 0) {
      return {
        value: 0.0,
        detail: {
          messages: 0,
          velocity: 0.0
        }
      };
    }

    // Velocity-based normalized score:
    // Uses smooth exponential saturation: 1 - exp(-velocity / baseline)
    // Strictly bounded in [0, 1], approaches 1.0 during hype bursts.
    const baseline = Math.max(0.1, this.config.baselineVelocity);
    const rawRatio = stats.velocity / baseline;
    const value = Number((1.0 - Math.exp(-rawRatio)).toFixed(4));
    const clampedValue = Math.min(1.0, Math.max(0.0, value));

    return {
      value: clampedValue,
      detail: {
        messages: stats.messages_in_window,
        velocity: stats.velocity
      }
    };
  }

  /**
   * Returns total number of active in-memory events.
   */
  public getInMemoryEventCount(): number {
    return this.events.length;
  }

  /**
   * Clears all in-memory events and user mappings.
   */
  public clear(): void {
    this.events.length = 0;
    this.ephemeralUserMap.clear();
    this.nextChatterId = 1;
    this.droppedEventsCount = 0;
  }

  private pruneOldEvents(currentT: number): void {
    const cutoff = currentT - this.config.baselineWindowSeconds;
    if (cutoff <= 0) return;

    let removeCount = 0;
    while (removeCount < this.events.length && this.events[removeCount].t < cutoff) {
      removeCount++;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }
  }
}
