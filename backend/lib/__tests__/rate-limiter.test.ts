import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createRateLimiter, resetBuckets } from '../rate-limiter.js';

function mockReq(userId: string, tier: 'free' | 'pro' = 'free') {
  return { user: { id: userId, email: 'test@test.com', tier } } as Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(key: string, val: string) {
      res.headers[key] = val;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  } as unknown as Response & { statusCode: number; headers: Record<string, string>; body: unknown };
  return res;
}

describe('rate-limiter', () => {
  const middleware = createRateLimiter();

  beforeEach(() => {
    resetBuckets();
  });

  it('allows first request', () => {
    const req = mockReq('user1');
    const res = mockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('allows requests within free tier limit', () => {
    const req = mockReq('user2');
    let nextCount = 0;
    const next: NextFunction = () => { nextCount++; };

    for (let i = 0; i < 50; i++) {
      middleware(req, mockRes(), next);
    }
    expect(nextCount).toBe(50);
  });

  it('blocks request #51 for free tier', () => {
    const req = mockReq('user3');
    const next: NextFunction = () => {};

    for (let i = 0; i < 50; i++) {
      middleware(req, mockRes(), next);
    }

    const res = mockRes();
    middleware(req, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('isolates buckets per user', () => {
    const next: NextFunction = () => {};

    // Fill user4's bucket
    const req4 = mockReq('user4');
    for (let i = 0; i < 50; i++) {
      middleware(req4, mockRes(), next);
    }

    // user5 should still work
    const req5 = mockReq('user5');
    const res = mockRes();
    let nextCalled = false;
    middleware(req5, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('allows pro tier higher limit', () => {
    const req = mockReq('user6', 'pro');
    let nextCount = 0;
    const next: NextFunction = () => { nextCount++; };

    for (let i = 0; i < 500; i++) {
      middleware(req, mockRes(), next);
    }
    expect(nextCount).toBe(500);

    // 501st should fail
    const res = mockRes();
    middleware(req, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('clears limits after resetBuckets()', () => {
    const req = mockReq('user7');
    const next: NextFunction = () => {};

    for (let i = 0; i < 50; i++) {
      middleware(req, mockRes(), next);
    }

    resetBuckets();

    let nextCalled = false;
    middleware(req, mockRes(), () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});
