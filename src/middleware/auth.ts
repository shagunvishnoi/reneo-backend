import { Request, Response, NextFunction } from 'express';
import { createUserClient } from '../config/supabase';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: 'SELLER' | 'CUSTOMER';
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 401, message: 'Missing or invalid authorization header' } });
  }

  const token = authHeader.split(' ')[1];
  const supabase = createUserClient(token);

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: { code: 401, message: 'Invalid or expired token' } });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(401).json({ error: { code: 401, message: 'Profile not found' } });
  }

  req.user = { id: user.id, role: profile.role as 'SELLER' | 'CUSTOMER' };
  next();
}

export function requireRole(role: 'SELLER' | 'CUSTOMER') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: { code: 403, message: `${role} role required` } });
    }
    next();
  };
}