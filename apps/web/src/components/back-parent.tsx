'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { registerParent } from '@/lib/back-navigation';

/**
 * Tells Telegram's BackButton where this page's parent is, for when there is no history to go
 * back to (a product opened from a shared link goes to its category). Renders nothing.
 */
export function BackParent({ href }: { href: string }) {
  const pathname = usePathname();
  useEffect(() => registerParent(pathname, href), [pathname, href]);
  return null;
}
