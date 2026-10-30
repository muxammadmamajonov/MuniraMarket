// @ts-check
/**
 * Mini App endpoint `getProfile`. Identity is the platform-verified `ctx.initData.user`;
 * `input` is ignored. Returns `{ user }` as provided by the Core API.
 */
import { db, fetch } from 'sdk';
import { getProfileWithConfig } from '../lib/miniapp/profile.js';

/**
 * @param {unknown} input
 * @param {{ initData?: { user?: unknown } }} ctx
 */
export default async function (input, ctx) {
  return getProfileWithConfig(input, ctx, { db, fetch });
}
