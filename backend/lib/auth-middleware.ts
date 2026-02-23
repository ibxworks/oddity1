import type { Request, Response, NextFunction } from 'express';
import { serviceClient } from './supabase.js';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; tier: 'free' | 'pro' };
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

  // Fetch tier from profiles table (default to 'free' if no profile exists)
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('tier')
    .eq('id', data.user.id)
    .single();

  req.user = {
    id: data.user.id,
    email: data.user.email ?? '',
    tier: (profile?.tier as 'free' | 'pro') ?? 'free',
  };

  next();
}
