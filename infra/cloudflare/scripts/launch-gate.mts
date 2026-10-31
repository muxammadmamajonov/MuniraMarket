#!/usr/bin/env node
/**
 * Automated part of the production launch gate (infra/launch/launch-checklist.md). Run with the
 * production deploy variables exported, right before the first production deploy and before
 * every production release:
 *
 *   node infra/cloudflare/scripts/launch-gate.mts
 *
 * It checks what the repository and the deploy environment can prove; everything that needs a
 * human (DNS, BotFather, devices, restore drill) stays in the checklist.
 */
import { isImagePreviewEnabled } from '../../../apps/admin/src/lib/config.ts';
import { buildContentSecurityPolicy } from '../../../apps/admin/src/lib/csp.ts';
import { LEGAL_CONTENT_STATUS } from '../../../apps/web/src/lib/legal/status.ts';
import { validateDeployEnv } from '../deploy-env.mts';

const blockers: string[] = [];

if (LEGAL_CONTENT_STATUS !== 'approved') {
  blockers.push(
    'legal pages: LEGAL_CONTENT_STATUS is not "approved" (privacy, offer, delivery, returns, contacts)',
  );
}

for (const problem of validateDeployEnv('production', process.env)) {
  blockers.push(`deploy env: ${problem.variable} ${problem.message}`);
}

// The admin may only load external images once their host is allow-listed in its CSP.
const adminImages =
  /img-src ([^;]*)/.exec(buildContentSecurityPolicy({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA==' }))?.[1] ??
  '';
const externalImageHost = adminImages.split(/\s+/).some((v) => v.startsWith('https://'));
if (isImagePreviewEnabled() && !externalImageHost) {
  blockers.push('admin: image preview is enabled but no image host is allow-listed in img-src');
}
if (adminImages.split(/\s+/).some((v) => v === 'https:' || v === '*')) {
  blockers.push('admin: img-src allows any https host');
}

if (blockers.length > 0) {
  console.error('Launch gate: NOT ready');
  for (const blocker of blockers) console.error(`  - ${blocker}`);
  process.exit(1);
}
console.log('Launch gate: automated checks passed; finish infra/launch/launch-checklist.md');
