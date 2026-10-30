import { notFound } from 'next/navigation';

/**
 * Catch-all so unknown URLs under a locale render `[locale]/not-found.tsx` inside the locale
 * layout (localized, with the site header) instead of Next's unstyled default 404.
 */
export default function UnknownPage(): never {
  notFound();
}
