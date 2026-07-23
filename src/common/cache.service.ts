import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Thin cache wrapper for expensive aggregate reads (Admin Dashboard).
 * No-op fallback when REDIS_URL is absent — consistent with the rest of the
 * codebase treating Redis as optional (queue.module.ts follows the same guard).
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis | null;

  constructor() {
    const url = process.env.REDIS_URL;
    this.redis = url ? new Redis(url, { family: 0, lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
    this.redis?.on('error', (err) => this.logger.warn(`Redis cache error: ${err.message}`));
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      /* cache is best-effort — ignore write failures */
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }
}
