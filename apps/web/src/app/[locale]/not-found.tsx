import { RouteHeader } from '@/components/route-header';
import { NotFoundView } from '@/components/status-views';

export default function NotFound() {
  return (
    <>
      <RouteHeader kind="notFound" />
      <main className="flex-1">
        <NotFoundView />
      </main>
    </>
  );
}
