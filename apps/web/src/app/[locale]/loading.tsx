import { Skeleton } from '@muniramarket/ui';
import { PageContainer } from '@/components/page-container';

/** Same footprint as `ProductTile`: borderless square photo, price line, two name lines. */
function TileSkeleton() {
  return (
    <div data-testid="tile-skeleton" className="flex w-full flex-col gap-1.5">
      <Skeleton className="aspect-square w-full rounded-2xl" />
      <Skeleton className="mt-0.5 h-5 w-1/2" />
      <div className="flex min-h-10 flex-col gap-1.5 pt-0.5">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
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
        <Skeleton className="h-16 w-full rounded-3xl bg-surface" />
        <Skeleton className="h-12 w-full rounded-2xl bg-surface" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-1/3" />
          <div className="flex gap-1 overflow-hidden py-1">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="flex w-[84px] shrink-0 flex-col items-center gap-1.5 p-1.5"
              >
                <Skeleton className="size-16 rounded-[22px]" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="h-[68px] w-full rounded-3xl bg-surface" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-1/2" />
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <TileSkeleton key={index} />
            ))}
          </div>
        </div>
      </PageContainer>
    </main>
  );
}
