import type { Request, Response, NextFunction } from 'express';
import type { UserTier } from '@oddity/shared';
import { serviceClient } from './supabase.js';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; tier: UserTier };
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  const { data, error } = await serviceClient.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Fetch tier + subscription_status from profiles table
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('tier, subscription_status')
    .eq('id', data.user.id)
    .single();

  // Treat past_due as still 'standard' (grace period while Stripe retries)
  let tier: UserTier = (profile?.tier as UserTier) ?? 'free';
  if (tier === 'free' && profile?.subscription_status === 'past_due') {
    tier = 'standard';
  }

  req.user = {
    id: data.user.id,
    email: data.user.email ?? '',
    tier,
  };

  next();
}
