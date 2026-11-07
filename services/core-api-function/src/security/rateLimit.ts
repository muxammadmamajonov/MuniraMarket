import type { Ctx } from '../http/context.ts';
import type { RateLimitRule } from '../http/auth.ts';
// PLACEHOLDER: implemented by the security work stream.
export async function rateLimit(_c: Ctx, _rule: RateLimitRule, _key: 'ip' | 'user'): Promise<void> { throw new Error('not implemented'); }
