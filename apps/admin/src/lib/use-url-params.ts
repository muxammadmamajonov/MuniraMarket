'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Filters and page of a list live in the URL, so they survive reload and the back button.
 * `replace` changes some params (a `null`/empty value removes one) and, unless it sets `page`
 * itself, goes back to the first page. `hrefWith` builds the link of a chip or pager.
 */
export function useUrlParams() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const build = useCallback(
    (patch: Record<string, string | null>): string => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in patch)) next.delete('page');
      const query = next.toString();
      return query === '' ? pathname : `${pathname}?${query}`;
    },
    [params, pathname],
  );

  const replace = useCallback(
    (patch: Record<string, string | null>) => router.replace(build(patch), { scroll: false }),
    [router, build],
  );

  return { params, pathname, replace, hrefWith: build };
}
