import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { ApiRequestError } from '@/lib/api/errors';
import { apiError, order, respond, WORST } from '@/lib/checkout/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { OrderDetailView } from './order-detail-view';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

const NB = ' ';
const ID = order().id;

function renderDetail(placed = false, locale: 'uz' | 'ru' = 'uz', found = false) {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <OrderDetailView id={ID} placed={placed} found={found} />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

type Handler = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler> = {};

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
  session.retry.mockReset();
  routes = { [`GET /orders/${ID}`]: () => respond(order()) };
  session.apiFetch.mockImplementation(async (path, init) => {
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (handler === undefined) throw new Error(`unhandled ${init?.method ?? 'GET'} ${path}`);
    return handler(init ?? {});
  });
});

function gets() {
  return session.apiFetch.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET');
}

describe('OrderDetailView: content', () => {
  it('shows number, status, date, lines, totals, address, recipient and payment', async () => {
    renderDetail();
    expect(await screen.findByTestId('order-number')).toHaveTextContent('Buyurtma № MM-000123');
    expect(screen.getByText('Yangi', { selector: '[data-status]' })).toBeInTheDocument();
    expect(screen.getAllByText(/01\.11\.2026 02:30/)).toHaveLength(2); // header + timeline

    const lines = screen.getAllByTestId('order-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Demo olma');
    expect(lines[0]?.textContent).toContain(`4 × 15${NB}000${NB}so‘m / kg`);
    expect(lines[0]?.textContent).toContain(`60${NB}000${NB}so‘m`);
    // No delivery fee line: the customer pays the Yandex courier, so the total is the goods.
    expect(screen.getByTestId('order-total').textContent).toBe(`60${NB}000${NB}so‘m`);
    expect(screen.queryByTestId('order-delivery')).toBeNull();

    const delivery = screen.getByRole('region', { name: 'Yetkazib berish manzili' });
    expect(delivery).toHaveTextContent('Demo ko‘cha');
    expect(delivery).toHaveTextContent('34');
    // Empty optional parts are left out rather than shown as dashes.
    expect(delivery).not.toHaveTextContent('Kirish');
    expect(delivery).not.toHaveTextContent('Qavat');
    expect(delivery).not.toHaveTextContent('Mo‘ljal');
    expect(screen.getByRole('region', { name: 'Qabul qiluvchi' })).toHaveTextContent(
      '+998001234567',
    );
    expect(screen.getByRole('region', { name: 'To‘lov usuli' })).toHaveTextContent(
      'Yetkazilganda naqd pul',
    );
    expect(screen.queryByTestId('order-comment')).toBeNull();
    expect(screen.queryByTestId('placed-banner')).toBeNull();
  });

  it('says the Yandex courier brings the order and is paid for delivery (uz, ru)', async () => {
    const first = renderDetail();
    const note = await screen.findByTestId('order-courier-note');
    expect(note).toHaveTextContent('Yandex kuryeri olib keladi. Yetkazish kuryerga to‘lanadi.');
    expect(screen.getByRole('region', { name: 'Yetkazib berish manzili' })).toContainElement(note);
    // Coordinates are for the courier link (staff side), never shown to the customer.
    expect(document.body.textContent).not.toMatch(/41\.311081|69\.240562/);
    first.unmount();

    renderDetail(false, 'ru');
    expect(await screen.findByTestId('order-courier-note')).toHaveTextContent(
      'Привезёт курьер Яндекса. Доставка оплачивается курьеру.',
    );
  });

  it('shows the total of an order placed before coordinates were stored', async () => {
    // Older orders: no point in the snapshot, and the total still includes the fee charged then.
    routes[`GET /orders/${ID}`] = () =>
      respond(order({ total_uzs: 75000, address: { ...order().address, lat: null, lon: null } }));
    renderDetail();
    expect((await screen.findByTestId('order-total')).textContent).toBe(`75${NB}000${NB}so‘m`);
    expect(screen.getByRole('region', { name: 'Yetkazib berish manzili' })).toHaveTextContent(
      'Demo ko‘cha',
    );
  });

  it('uses the snapshot names in the current locale (ru)', async () => {
    renderDetail(false, 'ru');
    expect(await screen.findByText('Демо яблоко')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Адрес доставки' })).toHaveTextContent('Demo ko‘cha');
    expect(screen.getByRole('region', { name: 'Способ оплаты' })).toHaveTextContent(
      'Наличными при получении',
    );
    expect(screen.getByTestId('order-total').textContent).toBe(`60${NB}000${NB}сум`);
  });

  it('shows the success banner only after placing (?placed=1)', async () => {
    renderDetail(true);
    expect(await screen.findByTestId('placed-banner')).toHaveTextContent(
      'Buyurtmangiz qabul qilindi!',
    );
    expect(screen.getByTestId('order-number')).toHaveTextContent('MM-000123');
    expect(screen.getByText('Yangi', { selector: '[data-status]' })).toBeInTheDocument();
  });

  it('says "we found your order" when a retry was answered with the existing order (?placed=found)', async () => {
    renderDetail(true, 'uz', true);
    const banner = await screen.findByTestId('placed-banner');
    expect(banner).toHaveAttribute('data-found', 'true');
    expect(banner).toHaveTextContent('Buyurtmangizni topdik');
    expect(banner).toHaveTextContent('ikkinchi marta yaratmadik');
    expect(banner).not.toHaveTextContent('Buyurtmangiz qabul qilindi!');
  });

  it('says it in Russian too', async () => {
    renderDetail(true, 'ru', true);
    expect(await screen.findByTestId('placed-banner')).toHaveTextContent('Мы нашли ваш заказ');
  });

  it('shows the comment and the timeline with Tashkent times, marking the current step', async () => {
    routes[`GET /orders/${ID}`] = () =>
      respond(
        order({
          status: 'CONFIRMED',
          comment: 'Eshik oldiga qoldiring',
          history: [
            { status: 'NEW', at: '2026-10-31T21:30:00Z' },
            { status: 'CONFIRMED', at: '2026-11-01T04:15:00Z' },
          ],
        }),
      );
    renderDetail();
    expect(await screen.findByTestId('order-comment')).toHaveTextContent('Eshik oldiga qoldiring');
    // The whole delivery path: what happened (with times), the current step, what comes next.
    const steps = within(screen.getByTestId('timeline')).getAllByRole('listitem');
    expect(steps).toHaveLength(6);
    expect(steps[0]).toHaveTextContent('Yangi');
    expect(steps[0]).toHaveTextContent('01.11.2026 02:30');
    expect(steps[0]).toHaveAttribute('data-state', 'done');
    expect(steps[1]).toHaveTextContent('Tasdiqlandi');
    expect(steps[1]).toHaveTextContent('01.11.2026 09:15');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    for (const upcoming of steps.slice(2)) {
      expect(upcoming).toHaveAttribute('data-state', 'upcoming');
      expect(upcoming.querySelector('time')).toBeNull();
    }
    expect(steps[5]).toHaveTextContent('Yetkazildi');
  });

  it('draws a cancelled order only up to the cancellation', async () => {
    routes[`GET /orders/${ID}`] = () =>
      respond(
        order({
          status: 'CANCELLED',
          can_cancel: false,
          history: [
            { status: 'NEW', at: '2026-10-31T21:30:00Z' },
            { status: 'CANCELLED', at: '2026-10-31T22:00:00Z' },
          ],
        }),
      );
    renderDetail();
    const steps = within(await screen.findByTestId('timeline')).getAllByRole('listitem');
    expect(steps.map((step) => step.getAttribute('data-state'))).toEqual(['done', 'cancelled']);
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
  });

  it('shows the cancel reason of a cancelled order and offers no cancel button', async () => {
    routes[`GET /orders/${ID}`] = () =>
      respond(
        order({
          status: 'CANCELLED',
          can_cancel: false,
          cancel_reason: 'Fikrimni o‘zgartirdim',
          history: [
            { status: 'NEW', at: '2026-10-31T21:30:00Z' },
            { status: 'CANCELLED', at: '2026-10-31T22:00:00Z' },
          ],
        }),
      );
    renderDetail();
    expect(await screen.findByTestId('cancel-reason')).toHaveTextContent('Fikrimni o‘zgartirdim');
    expect(screen.getByText('Bekor qilindi', { selector: '[data-status]' })).toBeInTheDocument();
    expect(screen.queryByTestId('cancel-order')).toBeNull();
  });

  it("renders a not-found state for a missing order (also other customers' orders)", async () => {
    routes[`GET /orders/${ID}`] = () => apiError('order_not_found', 404);
    renderDetail();
    expect(await screen.findByText('Buyurtma topilmadi')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Barcha buyurtmalar' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    expect(screen.queryByTestId('order-number')).toBeNull();
  });

  it('localizes the not-found state (ru) and treats a malformed id (422) the same way', async () => {
    routes[`GET /orders/${ID}`] = () => apiError('validation_error', 422);
    renderDetail(false, 'ru');
    expect(await screen.findByText('Заказ не найден')).toBeInTheDocument();
  });

  it('shows a skeleton while loading, the sign-in prompt when anonymous, and retries on failure', async () => {
    routes[`GET /orders/${ID}`] = () => new Promise<Response>(() => undefined);
    const first = renderDetail();
    expect(screen.getByRole('status', { name: 'Buyurtma yuklanmoqda…' })).toBeInTheDocument();
    first.unmount();

    session.status = 'anonymous';
    routes['GET /auth/config'] = () => respond({ telegram_oidc: { enabled: false } });
    const second = renderDetail();
    expect(await screen.findByText(/Telegram orqali oching/)).toBeInTheDocument();
    second.unmount();

    session.status = 'authenticated';
    routes[`GET /orders/${ID}`] = () => apiError('internal_error', 500);
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('Buyurtmalarni yuklab bo‘lmadi.');
    routes[`GET /orders/${ID}`] = () => respond(order());
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByTestId('order-number')).toBeInTheDocument();
  });
});

describe('OrderDetailView: cancelling', () => {
  async function openSheet() {
    renderDetail();
    fireEvent.click(await screen.findByTestId('cancel-order'));
    return screen.getByRole('dialog', { name: 'Buyurtmani bekor qilasizmi?' });
  }
  const confirm = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: 'Bekor qilish' });

  it('offers cancellation only when the API says the order can be cancelled', async () => {
    routes[`GET /orders/${ID}`] = () => respond(order({ can_cancel: false, status: 'PICKING' }));
    renderDetail();
    await screen.findByTestId('order-number');
    expect(screen.queryByTestId('cancel-order')).toBeNull();
  });

  it('requires a reason of at least 3 characters', async () => {
    const dialog = await openSheet();
    const textarea = within(dialog).getByLabelText('Bekor qilish sababi');
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveAttribute('maxlength', '300');

    // Empty: no error row until the customer tries to cancel (and the space is already reserved).
    fireEvent.blur(textarea);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(confirm(dialog));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('kamida 3 ta belgi');
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(session.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
      0,
    );

    fireEvent.change(textarea, { target: { value: '  abc  ' } });
    expect(within(dialog).queryByText(/kamida 3/)).toBeNull();
    expect(within(dialog).getByText('7/300')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'ab' } });
    fireEvent.blur(textarea);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('kamida 3 ta belgi');
  });

  it('fills the textarea from the quick-pick chips', async () => {
    const dialog = await openSheet();
    const textarea = within(dialog).getByLabelText('Bekor qilish sababi');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Xato buyurtma berdim' }));
    expect(textarea).toHaveValue('Xato buyurtma berdim');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fikrimni o‘zgartirdim' }));
    expect(textarea).toHaveValue('Fikrimni o‘zgartirdim');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('cancels with the reason, closes the sheet and shows the updated order', async () => {
    routes[`POST /orders/${ID}/cancel`] = () =>
      respond(
        order({
          status: 'CANCELLED',
          can_cancel: false,
          cancel_reason: 'Xato buyurtma berdim',
          history: [
            { status: 'NEW', at: '2026-10-31T21:30:00Z' },
            { status: 'CANCELLED', at: '2026-10-31T22:00:00Z' },
          ],
        }),
      );
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Xato buyurtma berdim' }));
    fireEvent.click(confirm(dialog));

    expect(await screen.findByTestId('cancelled-notice')).toHaveTextContent(
      'Buyurtma bekor qilindi.',
    );
    const call = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(call?.[0]).toBe(`/orders/${ID}/cancel`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reason: 'Xato buyurtma berdim' });

    expect(screen.getByText('Bekor qilindi', { selector: '[data-status]' })).toBeInTheDocument();
    expect(screen.getByTestId('cancel-reason')).toHaveTextContent('Xato buyurtma berdim');
    expect(screen.queryByTestId('cancel-order')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends the trimmed reason and blocks a double tap', async () => {
    let release: (response: Response) => void = () => undefined;
    routes[`POST /orders/${ID}/cancel`] = () =>
      new Promise<Response>((resolve) => (release = resolve));
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText('Bekor qilish sababi'), {
      target: { value: '  Boshqa joydan sotib oldim  ' },
    });
    fireEvent.click(confirm(dialog));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Bekor qilinmoqda…' })).toBeDisabled(),
    );
    fireEvent.submit(
      within(dialog).getByLabelText('Bekor qilish sababi').closest('form') as HTMLFormElement,
    );
    const posts = session.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      reason: 'Boshqa joydan sotib oldim',
    });
    release(respond(order({ status: 'CANCELLED', can_cancel: false })));
    await screen.findByTestId('cancelled-notice');
  });

  it('keeps the reason and explains when the order can no longer be cancelled', async () => {
    routes[`POST /orders/${ID}/cancel`] = () =>
      apiError('order_not_cancellable', 409, { current_status: 'PICKING' });
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText('Bekor qilish sababi'), {
      target: { value: 'Fikrimni o‘zgartirdim' },
    });
    const before = gets().length;
    routes[`GET /orders/${ID}`] = () => respond(order({ status: 'PICKING', can_cancel: false }));
    fireEvent.click(confirm(dialog));

    expect(await within(dialog).findByTestId('cancel-problem')).toHaveTextContent(
      'Buyurtma holati o‘zgardi: Yig‘ilmoqda.',
    );
    expect(within(dialog).getByLabelText('Bekor qilish sababi')).toHaveValue(
      'Fikrimni o‘zgartirdim',
    );
    // The order is reloaded in the background so the page reflects the new status.
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByText('Yig‘ilmoqda', { selector: '[data-status]' })).toBeInTheDocument(),
    );
  });

  it('keeps the reason on a network failure so the customer can retry', async () => {
    routes[`POST /orders/${ID}/cancel`] = () => {
      throw ApiRequestError.network();
    };
    const dialog = await openSheet();
    fireEvent.change(within(dialog).getByLabelText('Bekor qilish sababi'), {
      target: { value: 'Fikrimni o‘zgartirdim' },
    });
    fireEvent.click(confirm(dialog));
    expect(await within(dialog).findByTestId('cancel-problem')).toHaveTextContent(
      'Internet aloqasi yo‘q',
    );
    expect(within(dialog).getByLabelText('Bekor qilish sababi')).toHaveValue(
      'Fikrimni o‘zgartirdim',
    );
    expect(confirm(dialog)).toBeEnabled();
  });

  it('closes with "Buyurtmani saqlash" without sending anything', async () => {
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buyurtmani saqlash' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(session.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
      0,
    );
  });

  it('localizes the sheet (ru)', async () => {
    renderDetail(false, 'ru');
    fireEvent.click(await screen.findByTestId('cancel-order'));
    const dialog = screen.getByRole('dialog', { name: 'Отменить заказ?' });
    expect(within(dialog).getByRole('button', { name: 'Передумал(а)' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Причина отмены')).toBeInTheDocument();
  });
});

describe('OrderDetailView: worst-case data (break-ui)', () => {
  it('keeps 50 lines, 255-character names, quantity 99, long address text and a huge total readable', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      product_id: index % 7 === 0 ? null : `p${String(index)}`,
      sku: `SKU-${String(index)}`,
      name_uz: `${String(index)} ${WORST.productNameUz}`.slice(0, 255),
      name_ru: `${String(index)} ${WORST.productNameRu}`.slice(0, 255),
      unit: 'kg' as const,
      unit_price_uzs: 199_999_980,
      quantity: 99,
      line_total_uzs: 99 * 199_999_980,
    }));
    routes[`GET /orders/${ID}`] = () =>
      respond(
        order({
          number: `MM-${'0'.repeat(30)}1`,
          items,
          item_count: 4950,
          subtotal_uzs: WORST.hugeTotal,
          total_uzs: WORST.hugeTotal,
          recipient_name: WORST.recipientName,
          comment: WORST.comment,
          address: {
            lat: 41.311081,
            lon: 69.240562,
            street: WORST.street,
            house: 'x'.repeat(32),
            apartment: 'x'.repeat(16),
            entrance: 'x'.repeat(16),
            floor: 'x'.repeat(8),
            landmark: WORST.landmark,
          },
        }),
      );
    renderDetail(true, 'ru');
    await screen.findByTestId('order-number');

    expect(screen.getAllByTestId('order-line')).toHaveLength(50);
    const firstName = screen.getAllByTestId('order-line')[0]?.querySelector('[data-user-text]');
    expect(firstName?.textContent?.length).toBe(255);
    expect(firstName?.className).not.toContain('truncate');

    const total = screen.getByTestId('order-total');
    expect(total.textContent).toBe('9 999 999 000 сум');
    expect(total).toHaveAttribute('data-money');
    expect(total.className).toContain('shrink-0');

    // Everything the customer typed wraps anywhere and can shrink in its grid cell.
    const street = within(screen.getByRole('region', { name: 'Адрес доставки' })).getByText(
      WORST.street,
    );
    expect(street).toHaveAttribute('data-user-text');
    expect(street.className).toContain('min-w-0');
    expect(screen.getByTestId('order-number')).toHaveAttribute('data-user-text');
    expect(screen.getByTestId('order-comment').textContent).toBe(WORST.comment);
    expect(screen.getByText(WORST.recipientName)).toHaveAttribute('data-user-text');
    expect(screen.getAllByText('Товар удалён из каталога').length).toBeGreaterThan(0);
    expect(screen.getByText(/4950 товаров/)).toBeInTheDocument();
    expect(document.querySelector('.truncate')).toBeNull();
  });

  it('handles a single one-unit line (1 item) in both languages', async () => {
    routes[`GET /orders/${ID}`] = () =>
      respond(
        order({
          item_count: 1,
          items: [{ ...order().items[0]!, quantity: 1, line_total_uzs: 15000 }],
        }),
      );
    const uz = renderDetail();
    expect(await screen.findByText(/1 ta mahsulot/)).toBeInTheDocument();
    uz.unmount();
    renderDetail(false, 'ru');
    expect(await screen.findByText(/1 товар(?!ов|а)/)).toBeInTheDocument();
  });
});
