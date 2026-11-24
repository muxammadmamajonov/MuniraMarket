import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/site';

/**
 * The catalog is public; everything that belongs to one visitor, the sign-in landing page, the
 * search results (endless query variations) and the API proxy are not for crawlers. The paths
 * are locale-prefixed (`/uz/cart`, `/ru/cart`), hence the `*`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/*/cart',
        '/*/checkout',
        '/*/orders',
        '/*/profile',
        '/*/search',
        '/*/auth/',
      ],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
