'use client';

import { useI18n } from '@/i18n/context';
import { useIsOffline } from '@/lib/network-status';

/**
 * Localized banner shown while the browser is offline or the last API request could not reach the
 * server. It disappears by itself when connectivity returns.
 */
export function OfflineBanner() {
  const { dict } = useI18n();
  const offline = useIsOffline();
  if (!offline) return null;

  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="bg-warning-soft px-4 py-2 text-center text-sm font-medium text-warning"
    >
      {dict.offline.banner}
    </div>
  );
}
