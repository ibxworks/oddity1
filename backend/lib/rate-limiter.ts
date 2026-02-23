import type { Request, Response, NextFunction } from 'express';
import { RATE_LIMIT_FREE, RATE_LIMIT_PRO } from '@oddity/shared';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function getResetTime(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

export function resetBuckets(): void {
  buckets.clear();
}

export function createRateLimiter() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = req.user.id;
    const limit = req.user.tier === 'pro' ? RATE_LIMIT_PRO : RATE_LIMIT_FREE;
    const now = Date.now();

    let bucket = buckets.get(userId);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: getResetTime() };
      buckets.set(userId, bucket);
    }

    bucket.count++;

    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Rate limit exceeded',
        limit,
        retry_after: retryAfter,
      });
      return;
    }

    next();
  };
}
