import type { ReactNode } from 'react';
import { AdminOnly } from '@/components/ui/resource-view';

/**
 * Catalog, delivery, users and audit are admin-only. An operator sees "permission denied" and the
 * page below is never mounted, so it makes no admin-only request. Core API enforces the same rule
 * (403 before any entity is read); this group just makes it friendly.
 */
export default function AdminOnlyLayout({ children }: { children: ReactNode }) {
  return <AdminOnly>{children}</AdminOnly>;
}
