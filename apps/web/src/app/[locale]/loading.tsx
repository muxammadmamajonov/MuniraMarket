import { Skeleton } from '@muniramarket/ui';
import { PageContainer } from '@/components/page-container';

/** Shown while a page's server data loads. Decorative: skeletons are hidden from screen readers. */
export default function Loading() {
  return (
    <main className="flex-1" aria-busy="true">
      <PageContainer className="flex flex-col gap-4 py-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-11 w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-56" />
          ))}
        </div>
      </PageContainer>
    </main>
  );
}
