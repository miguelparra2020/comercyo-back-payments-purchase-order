import { jwtVerify } from 'jose';
import { requiredEnv } from './env.utils';

export interface AccessTokenPayload {
  id_user: number;
  session_id: string;
}

const getSecretKey = () => new TextEncoder().encode(requiredEnv('JWT_SECRET'));
const getAudience = () => requiredEnv('JWT_AUDIENCE');

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { audience: getAudience() });
    if (typeof payload.id_user !== 'number' || typeof payload.session_id !== 'string') {
      return null;
    }
    return { id_user: payload.id_user, session_id: payload.session_id };
  } catch {
    return null;
  }
}
