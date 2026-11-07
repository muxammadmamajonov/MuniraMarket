import type { Ctx, ServiceContext } from '../http/context.ts';
// PLACEHOLDER: implemented by the security work stream.
export async function requireServiceRequest(_c: Ctx): Promise<ServiceContext> { throw new Error('not implemented'); }
export async function requireActor(_c: Ctx): Promise<number> { throw new Error('not implemented'); }
