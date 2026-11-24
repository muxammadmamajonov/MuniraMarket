import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_ID,
  installFakeApi,
  json,
  orderDetail,
  renderAdmin,
  sessionHandler,
} from '@/test-utils/fake-api';
import { AdjustDialog } from './order-adjust';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => `/ru/orders/${ORDER_ID}`,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const PRODUCT_ID = '3f2b6a10-8c1d-4e2f-9a77-5b6c7d8e9f01';
const ITEM_PATH = `/api/v1/admin/orders/${ORDER_ID}/items/${PRODUCT_ID}`;

function setup() {
  const order = orderDetail();
  const line = { ...order.items[0]!, product_id: PRODUCT_ID };
  const api = installFakeApi(sessionHandler('operator'), (call) =>
    call.method === 'PATCH' && call.path === ITEM_PATH ? json(order) : undefined,
  );
  const onAdjusted = vi.fn();
  renderAdmin(
    <AdjustDialog
      order={order}
      line={line}
      returnFocusTo={null}
      onClose={vi.fn()}
      onAdjusted={onAdjusted}
    />,
  );
  const patches = () => api.calls.filter((call) => call.method === 'PATCH');
  return { api, onAdjusted, patches };
}

describe('AdjustDialog: out-of-stock marking', () => {
  it('leaves "mark as out of stock" off by default and sends mark_out_of_stock: false', async () => {
    const { onAdjusted, patches } = setup();
    const checkbox = await screen.findByTestId('adjust-mark-out');
    expect(checkbox).not.toBeChecked();

    fireEvent.change(screen.getByTestId('adjust-quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('adjust-confirm'));
    await waitFor(() => expect(onAdjusted).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toMatchObject({ quantity: 1, mark_out_of_stock: false });
  });

  it('asks again before zeroing the product stock, and sends nothing until confirmed', async () => {
    const { onAdjusted, patches } = setup();
    fireEvent.click(await screen.findByTestId('adjust-mark-out'));
    fireEvent.change(screen.getByTestId('adjust-quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('adjust-confirm'));

    // The warning is shown and nothing has been sent.
    expect(await screen.findByTestId('adjust-mark-out-warning')).toBeInTheDocument();
    expect(patches()).toHaveLength(0);

    // Going back keeps the dialog open and the choice editable.
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.queryByTestId('adjust-mark-out-warning')).not.toBeInTheDocument();
    expect(patches()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('adjust-confirm'));
    fireEvent.click(await screen.findByTestId('adjust-confirm'));
    await waitFor(() => expect(onAdjusted).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toMatchObject({ quantity: 1, mark_out_of_stock: true });
  });

  it('shows no warning when the checkbox is switched off again', async () => {
    const { onAdjusted, patches } = setup();
    const checkbox = await screen.findByTestId('adjust-mark-out');
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('adjust-confirm'));
    await waitFor(() => expect(onAdjusted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('adjust-mark-out-warning')).not.toBeInTheDocument();
    expect(patches()[0]?.body).toMatchObject({ mark_out_of_stock: false });
  });
});
