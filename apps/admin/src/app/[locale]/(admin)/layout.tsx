import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin-shell';

/** Everything below this group is a back-office screen behind the session/role gate. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
