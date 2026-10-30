import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_ID,
  apiError,
  deferred,
  installFakeApi,
  json,
  money,
  orderDetail,
  renderAdmin,
  sessionHandler,
  type FakeCall,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { OrderDetailView } from './order-detail';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => `/ru/orders/${ORDER_ID}`,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORDER_PATH = `/api/v1/admin/orders/${ORDER_ID}`;
const STATUS_PATH = `${ORDER_PATH}/status`;

const getOrder =
  (...orders: Array<ReturnType<typeof orderDetail>>): FakeHandler =>
  (call: FakeCall) => {
    if (call.method !== 'GET' || call.path !== ORDER_PATH) return undefined;
    // Each GET answers with the next order; the last one repeats.
    const next = orders.length > 1 ? orders.shift() : orders[0];
    return json(next);
  };

const patches = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((call) => call.method === 'PATCH');

describe('OrderDetailView: content', () => {
  it('shows items, totals, recipient, address, comment and the timeline (ru)', async () => {
    installFakeApi(
      sessionHandler('operator'),
      getOrder(
        orderDetail({
          status: 'CANCELLED',
          cancel_reason: 'Customer asked to cancel',
          allowed_transitions: [],
          history_detail: [
            {
              from_status: null,
              status: 'NEW',
              actor_role: 'customer',
              reason: null,
              at: '2026-10-31T09:05:00Z',
            },
            {
              from_status: 'NEW',
              status: 'CANCELLED',
              actor_role: 'operator',
              reason: 'Customer asked to cancel',
              at: '2026-10-31T10:30:00Z',
            },
          ],
        }),
      ),
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);

    expect(await screen.findByRole('heading', { name: 'Заказ MM-000123' })).toBeInTheDocument();
    // Items in the page language, with unit and line total.
    expect(screen.getByText('Тестовое яблоко')).toBeInTheDocument();
    expect(screen.getByText('Артикул: TEST-APPLE')).toBeInTheDocument();
    expect(screen.getByText(money(60000, 'ru'))).toBeInTheDocument();
    expect(
      screen.getByText((content) => content.replace(/\s+/g, ' ') === '2 кг × 30 000 сум'),
    ).toBeInTheDocument();
    // Totals.
    expect(screen.getByText(money(110000, 'ru'))).toBeInTheDocument();
    expect(screen.getByText(money(15000, 'ru'))).toBeInTheDocument();
    expect(screen.getByText(money(125000, 'ru'))).toBeInTheDocument();
    // Recipient and structured address.
    expect(screen.getByText('Test Recipient')).toBeInTheDocument();
    expect(screen.getByText('Наличные при получении')).toBeInTheDocument();
    for (const [label, value] of [
      ['Район', 'Чиланзар'],
      ['Улица', 'Test street'],
      ['Дом', '12'],
      ['Квартира', '34'],
      ['Подъезд', '2'],
      ['Этаж', '5'],
      ['Ориентир', 'Near the test park'],
    ] as const) {
      expect(screen.getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    // Comment and cancel reason.
    expect(screen.getByText('Call before arriving')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Причина отмены' })).toBeInTheDocument();
    // Timeline: status, actor role, reason and Tashkent time.
    const timeline = within(screen.getByRole('list', { name: 'История статусов' }));
    expect(timeline.getByText('Заказ создан')).toBeInTheDocument();
    expect(timeline.getByText('Клиент')).toBeInTheDocument();
    expect(timeline.getByText('Оператор')).toBeInTheDocument();
    expect(timeline.getByText('31.10.2026 14:05')).toBeInTheDocument();
    expect(timeline.getByText('31.10.2026 15:30')).toBeInTheDocument();
    expect(timeline.getByText('Причина: Customer asked to cancel')).toBeInTheDocument();
    // No transitions left: no action buttons.
    expect(screen.getByText('Других действий для этого заказа нет.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();
  });

  it('renders the phone as a tel: link and uses uz names and district', async () => {
    installFakeApi(sessionHandler('admin'), getOrder(orderDetail()));
    renderAdmin(<OrderDetailView id={ORDER_ID} />, 'uz');
    const phone = await screen.findByRole('link', { name: '+998 00 000 00 00' });
    expect(phone).toHaveAttribute('href', 'tel:+998000000000');
    expect(screen.getByText('Test olma')).toBeInTheDocument();
    expect(screen.getByText('Chilonzor')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Buyurtma MM-000123' })).toBeInTheDocument();
  });

  it('omits empty optional address parts and comment', async () => {
    installFakeApi(
      sessionHandler('operator'),
      getOrder(
        orderDetail({
          comment: null,
          address: {
            ...orderDetail().address,
            apartment: null,
            entrance: null,
            floor: null,
            landmark: null,
          },
        }),
      ),
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    await screen.findByRole('heading', { name: 'Заказ MM-000123' });
    for (const label of ['Квартира', 'Подъезд', 'Этаж', 'Ориентир']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('heading', { name: 'Комментарий' })).not.toBeInTheDocument();
  });

  it('shows a loading state, then not-found for an unknown order', async () => {
    const gate = deferred<Response>();
    installFakeApi(sessionHandler('operator'), () => gate.promise);
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    expect(await screen.findByRole('status', { name: 'Загрузка заказа…' })).toBeInTheDocument();
    gate.resolve(apiError(404, 'order_not_found'));
    expect(await screen.findByRole('heading', { name: 'Заказ не найден' })).toBeInTheDocument();
  });

  it('shows an error with retry for other failures', async () => {
    let attempts = 0;
    installFakeApi(sessionHandler('operator'), (call) => {
      if (call.path !== ORDER_PATH) return undefined;
      attempts += 1;
      return attempts === 1 ? apiError(503, 'service_unavailable') : json(orderDetail());
    });
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Заказ MM-000123' })).toBeInTheDocument();
  });
});

describe('OrderDetailView: actions', () => {
  it('offers the forward step as the primary action and Cancel from allowed_transitions', async () => {
    installFakeApi(
      sessionHandler('operator'),
      getOrder(orderDetail({ allowed_transitions: ['CONFIRMED', 'CANCELLED'] })),
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    expect(await screen.findByRole('button', { name: 'Подтвердить' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Отменить' })).toBeEnabled();
    // Nothing the API did not list is offered.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Выйти',
      'Подтвердить',
      'Отменить',
    ]);
  });

  it('labels each forward step and offers only what is allowed (ready -> out for delivery)', async () => {
    installFakeApi(
      sessionHandler('operator'),
      getOrder(
        orderDetail({ status: 'READY_FOR_DELIVERY', allowed_transitions: ['OUT_FOR_DELIVERY'] }),
      ),
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    expect(await screen.findByRole('button', { name: 'Передать курьеру' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();
  });

  it('moves the order forward, sending the displayed status as expected_status', async () => {
    const api = installFakeApi(
      sessionHandler('operator', 'csrf-xyz'),
      getOrder(orderDetail()),
      (call) =>
        call.method === 'PATCH' && call.path === STATUS_PATH
          ? json(
              orderDetail({ status: 'CONFIRMED', allowed_transitions: ['PICKING', 'CANCELLED'] }),
            )
          : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('button', { name: 'Начать сборку' })).toBeInTheDocument();
    expect(patches(api)).toHaveLength(1);
    expect(patches(api)[0]?.body).toEqual({ status: 'CONFIRMED', expected_status: 'NEW' });
    expect(patches(api)[0]?.headers.get('x-csrf-token')).toBe('csrf-xyz');
    expect(patches(api)[0]?.headers.get('content-type')).toBe('application/json');
    expect(screen.getByRole('status')).toHaveTextContent('Статус заказа обновлён: «Подтверждён».');
    // The new status is the one the next change expects.
    expect(screen.getAllByText('Подтверждён').length).toBeGreaterThan(0);
  });

  it('ignores a second click while the first request is in flight', async () => {
    const gate = deferred<Response>();
    const api = installFakeApi(sessionHandler('operator'), getOrder(orderDetail()), (call) =>
      call.method === 'PATCH' ? gate.promise : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    const button = await screen.findByRole('button', { name: 'Подтвердить' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    // While it runs, every action is disabled.
    for (const name of ['Сохранение…', 'Отменить']) {
      for (const action of screen.getAllByRole('button', { name })) expect(action).toBeDisabled();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    gate.resolve(json(orderDetail({ status: 'CONFIRMED', allowed_transitions: ['PICKING'] })));
    expect(await screen.findByRole('button', { name: 'Начать сборку' })).toBeEnabled();
    expect(patches(api)).toHaveLength(1);
  });

  it('allows another change once the request has finished', async () => {
    const api = installFakeApi(sessionHandler('operator'), getOrder(orderDetail()), (call) =>
      call.method === 'PATCH'
        ? json(orderDetail({ status: 'CONFIRMED', allowed_transitions: ['PICKING'] }))
        : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Начать сборку' }));
    await waitFor(() => expect(patches(api)).toHaveLength(2));
    expect(patches(api)[1]?.body).toEqual({ status: 'PICKING', expected_status: 'CONFIRMED' });
  });

  it('on a 409 order_status_conflict reloads the order and tells the user (no overwrite)', async () => {
    const stale = orderDetail();
    const fresh = orderDetail({
      status: 'CONFIRMED',
      allowed_transitions: ['PICKING', 'CANCELLED'],
    });
    const api = installFakeApi(sessionHandler('operator'), getOrder(stale, fresh), (call) =>
      call.method === 'PATCH'
        ? apiError(409, 'order_status_conflict', { current_status: 'CONFIRMED' })
        : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Статус заказа изменил другой сотрудник: сейчас «Подтверждён».',
    );
    // The reloaded order is shown and its actions replace the stale ones.
    expect(await screen.findByRole('button', { name: 'Начать сборку' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).not.toBeInTheDocument();
    expect(
      api.calls.filter((call) => call.method === 'GET' && call.path === ORDER_PATH),
    ).toHaveLength(2);
    expect(patches(api)).toHaveLength(1);
  });

  it('shows an error on invalid_status_transition', async () => {
    installFakeApi(sessionHandler('operator'), getOrder(orderDetail()), (call) =>
      call.method === 'PATCH'
        ? apiError(409, 'invalid_status_transition', { current_status: 'NEW' })
        : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Переход в этот статус невозможен.');
    // Buttons are usable again.
    expect(screen.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
  });

  it('shows a generic error when the request fails', async () => {
    installFakeApi(sessionHandler('operator'), getOrder(orderDetail()), (call) =>
      call.method === 'PATCH' ? apiError(503, 'service_unavailable') : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось изменить статус.');
  });
});

describe('OrderDetailView: cancel dialog', () => {
  async function openDialog() {
    const api = installFakeApi(
      sessionHandler('operator', 'csrf-c'),
      getOrder(orderDetail()),
      (call) =>
        call.method === 'PATCH'
          ? json(
              orderDetail({
                status: 'CANCELLED',
                cancel_reason: 'Out of stock',
                allowed_transitions: [],
                can_cancel: false,
              }),
            )
          : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отмена заказа' });
    return { api, dialog: within(dialog), element: dialog };
  }

  it('opens a dialog with the reason field focused', async () => {
    const { dialog } = await openDialog();
    expect(dialog.getByLabelText('Причина отмены')).toHaveFocus();
  });

  it.each([
    ['', 'empty'],
    ['  ', 'blank'],
    ['ab', 'too short'],
    ['  a  ', 'too short after trim'],
  ])('requires a reason of at least 3 characters (%j: %s) and sends nothing', async (value) => {
    const { api, dialog } = await openDialog();
    fireEvent.change(dialog.getByLabelText('Причина отмены'), { target: { value } });
    fireEvent.click(dialog.getByRole('button', { name: 'Отменить заказ' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Причина должна содержать от 3 до 300 символов.',
    );
    expect(patches(api)).toHaveLength(0);
    expect(dialog.getByLabelText('Причина отмены')).toHaveAttribute('aria-invalid', 'true');
  });

  it('caps the reason at 300 characters', async () => {
    const { dialog } = await openDialog();
    expect(dialog.getByLabelText('Причина отмены')).toHaveAttribute('maxlength', '300');
  });

  it('cancels with the trimmed reason and expected_status, then closes', async () => {
    const { api, dialog } = await openDialog();
    fireEvent.change(dialog.getByLabelText('Причина отмены'), {
      target: { value: '  Out of stock  ' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Отменить заказ' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patches(api)).toHaveLength(1);
    expect(patches(api)[0]?.body).toEqual({
      status: 'CANCELLED',
      reason: 'Out of stock',
      expected_status: 'NEW',
    });
    expect(patches(api)[0]?.headers.get('x-csrf-token')).toBe('csrf-c');
    expect(await screen.findByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();
  });

  it('submits once even if confirm is pressed repeatedly', async () => {
    const gate = deferred<Response>();
    const api = installFakeApi(sessionHandler('operator'), getOrder(orderDetail()), (call) =>
      call.method === 'PATCH' ? gate.promise : undefined,
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Причина отмены'), {
      target: { value: 'Duplicate order' },
    });
    const confirm = dialog.getByRole('button', { name: 'Отменить заказ' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.submit(confirm.closest('form') as HTMLFormElement);
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(confirm).toBeDisabled();
    gate.resolve(json(orderDetail({ status: 'CANCELLED', allowed_transitions: [] })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(patches(api)).toHaveLength(1);
  });

  it('closes with Escape or the close button without sending anything', async () => {
    const { api } = await openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отменить' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Закрыть' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(patches(api)).toHaveLength(0);
  });

  it('keeps Tab inside the dialog', async () => {
    const { dialog } = await openDialog();
    const close = dialog.getByRole('button', { name: 'Закрыть' });
    const confirm = dialog.getByRole('button', { name: 'Отменить заказ' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(dialog.getByLabelText('Причина отмены')).toHaveFocus();
    fireEvent.keyDown(dialog.getByLabelText('Причина отмены'), { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    expect(close).not.toHaveFocus();
  });

  it('reloads and closes the dialog on a conflict, keeps it open on a plain failure', async () => {
    let mode: 'fail' | 'conflict' = 'fail';
    installFakeApi(
      sessionHandler('operator'),
      getOrder(
        orderDetail(),
        orderDetail({
          status: 'PICKING',
          allowed_transitions: ['READY_FOR_DELIVERY', 'CANCELLED'],
        }),
      ),
      (call) => {
        if (call.method !== 'PATCH') return undefined;
        return mode === 'fail'
          ? apiError(503, 'service_unavailable')
          : apiError(409, 'order_status_conflict', { current_status: 'PICKING' });
      },
    );
    renderAdmin(<OrderDetailView id={ORDER_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Причина отмены'), {
      target: { value: 'Customer request' },
    });

    fireEvent.click(dialog.getByRole('button', { name: 'Отменить заказ' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Не удалось изменить статус.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The reason the user typed is still there.
    expect(dialog.getByLabelText('Причина отмены')).toHaveValue('Customer request');

    mode = 'conflict';
    fireEvent.click(dialog.getByRole('button', { name: 'Отменить заказ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('status')).toHaveTextContent('сейчас «Сборка»');
  });
});
