import { Skeleton } from '@muniramarket/ui';
import { PageContainer } from '@/components/page-container';

/** Same footprint as `ProductTile`: padded card, square image, two text lines, price, 44px button. */
function TileSkeleton() {
  return (
    <div
      data-testid="tile-skeleton"
      className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-2"
    >
      <Skeleton className="aspect-square w-full" />
      <div className="flex min-h-10 flex-col gap-1.5 pt-1">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="mt-1 h-11 w-full" />
    </div>
  );
}

/**
 * Shown while a page's server data loads. It mirrors the storefront's shape (search, category
 * rail, product grid) so nothing jumps when the content arrives. Decorative: skeletons are hidden
 * from screen readers.
 */
export default function Loading() {
  return (
    <main className="flex-1" aria-busy="true">
      <PageContainer className="flex flex-col gap-5 py-4">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-1/3" />
          <div className="flex gap-1 overflow-hidden py-1">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="flex w-[78px] shrink-0 flex-col items-center gap-1.5 p-1.5"
              >
                <Skeleton className="h-14 w-14 rounded-2xl" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="h-24 w-full rounded-2xl sm:h-20" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-1/2" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <TileSkeleton key={index} />
            ))}
          </div>
        </div>
      </PageContainer>
    </main>
  );
}
