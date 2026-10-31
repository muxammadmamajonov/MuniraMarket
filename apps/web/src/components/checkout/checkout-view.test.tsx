import type { DistrictCode } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { ApiRequestError } from '@/lib/api/errors';
import {
  WORST,
  apiError,
  cart,
  farZone,
  line,
  order,
  product,
  quote,
  respond,
  slotOption,
  slotQuote,
  zone,
} from '@/lib/checkout/test-fixtures';
import { isValidIdempotencyKey } from '@/lib/checkout/idempotency';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import type { TelegramWebApp } from '@/lib/telegram/types';
import { CheckoutView } from './checkout-view';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace }) }));

const USER_ID = vi.hoisted(() => '7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c');
const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: USER_ID, first_name: 'Ali', last_name: 'Valiyev' } as {
    id: string;
    first_name: string;
    last_name: string | null;
  } | null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

const NB = ' ';
const uzs = (amount: number) => `${String(amount).replace(/\B(?=(\d{3})+$)/g, NB)}${NB}so‘m`;

type Handler = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler> = {};

function defaultRoutes(): Record<string, Handler> {
  return {
    'GET /cart': () => respond(cart()),
    'GET /delivery/zones': () => respond({ items: [zone(), farZone()], timezone: 'Asia/Tashkent' }),
    'POST /checkout/quote': (init) => {
      const { district } = JSON.parse(String(init.body)) as { district: DistrictCode };
      return respond(
        district === 'chilonzor'
          ? quote({
              zone: farZone(),
              delivery_fee_uzs: 0,
              total_uzs: 60000,
              issues: ['below_min_order'],
              can_place_order: false,
              free_delivery_remaining_uzs: null,
            })
          : quote(),
      );
    },
    'POST /orders': () => respond(order(), 201),
  };
}

function calls(method: string, path: string) {
  return session.apiFetch.mock.calls.filter(
    ([p, init]) => p === path && (init?.method ?? 'GET') === method,
  );
}
const orderPosts = () => calls('POST', '/orders');
const keyOf = (index: number) =>
  (orderPosts()[index]?.[1]?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
const bodyOf = (index: number) => JSON.parse(String(orderPosts()[index]?.[1]?.body));

function trackedWebApp() {
  const state = { text: '', disabled: false, progress: false, visible: false };
  const base = makeWebApp({
    HapticFeedback: {
      impactOccurred: vi.fn(),
      notificationOccurred: vi.fn(),
      selectionChanged: vi.fn(),
    },
  } as Partial<TelegramWebApp>);
  const webApp: TelegramWebApp = {
    ...base,
    MainButton: {
      ...base.MainButton,
      setText: vi.fn((text: string) => {
        state.text = text;
      }),
      show: vi.fn(() => {
        state.visible = true;
      }),
      hide: vi.fn(() => {
        state.visible = false;
      }),
      enable: vi.fn(() => {
        state.disabled = false;
      }),
      disable: vi.fn(() => {
        state.disabled = true;
      }),
      showProgress: vi.fn(() => {
        state.progress = true;
      }),
      hideProgress: vi.fn(() => {
        state.progress = false;
      }),
    },
  };
  installWebApp(webApp);
  return { webApp, state };
}

function pressMainButton(webApp: TelegramWebApp) {
  const handlers = vi.mocked(webApp.MainButton.onClick).mock.calls;
  const handler = handlers[handlers.length - 1]?.[0];
  if (handler === undefined) throw new Error('MainButton has no click handler');
  handler();
}

function renderCheckout(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CheckoutView />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

async function loaded() {
  await screen.findByLabelText('Tuman');
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function pickDistrict(code: DistrictCode = 'yunusobod') {
  fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: code } });
  await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).not.toBe('—'));
}

/** Fills everything that is required (the name and the +998 prefix are prefilled). */
async function fillValid() {
  await pickDistrict();
  type('Ko‘cha', 'Demo ko‘cha');
  type('Uy', '12');
  type('Telefon raqami', '+998 00 123-45-67');
  fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
}

const submitButton = () => within(screen.getByTestId('submit-bar')).getByRole('button');

beforeEach(() => {
  nav.replace.mockReset();
  session.status = 'authenticated';
  session.user = { id: USER_ID, first_name: 'Ali', last_name: 'Valiyev' };
  window.sessionStorage.clear();
  session.apiFetch.mockReset();
  session.retry.mockReset();
  routes = defaultRoutes();
  session.apiFetch.mockImplementation(async (path, init) => {
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (handler === undefined) throw new Error(`unhandled ${init?.method ?? 'GET'} ${path}`);
    return handler(init ?? {});
  });
});

afterEach(() => {
  uninstallWebApp();
  vi.restoreAllMocks();
});

describe('CheckoutView: states', () => {
  it('shows a skeleton while the session loads and the sign-in prompt when anonymous', () => {
    session.status = 'loading';
    const { unmount } = renderCheckout();
    expect(screen.getByRole('status', { name: 'Buyurtma tayyorlanmoqda…' })).toBeInTheDocument();
    unmount();

    session.status = 'anonymous';
    routes['GET /auth/config'] = () =>
      respond({ telegram_login_widget: { enabled: false, bot_username: null } });
    renderCheckout();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Savatdan foydalanish uchun saytni Telegram orqali oching.',
    );
    expect(calls('GET', '/cart')).toHaveLength(0);
  });

  it('shows a skeleton while the cart and zones load', () => {
    routes['GET /cart'] = () => new Promise<Response>(() => undefined);
    renderCheckout();
    expect(screen.getByRole('status', { name: 'Buyurtma tayyorlanmoqda…' })).toBeInTheDocument();
  });

  it('shows an empty state with a way to the catalog when the cart is empty', async () => {
    routes['GET /cart'] = () =>
      respond(cart({ items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0 }));
    renderCheckout();
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Katalogga o‘tish' })).toHaveAttribute('href', '/uz');
    expect(screen.queryByLabelText('Tuman')).toBeNull();
  });

  it('offers a retry when loading fails', async () => {
    routes['GET /cart'] = () => apiError('internal_error', 500);
    renderCheckout();
    expect(await screen.findByRole('alert')).toHaveTextContent('Ma’lumotlarni yuklab bo‘lmadi.');
    routes['GET /cart'] = () => respond(cart());
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    await loaded();
  });

  it('asks the session layer to recover when loading finds the session gone', async () => {
    routes['GET /cart'] = () => apiError('session_required', 401);
    renderCheckout();
    await screen.findByRole('alert');
    expect(session.retry).toHaveBeenCalled();
  });

  it('is localized (ru) including the zone group labels', async () => {
    renderCheckout('ru');
    await screen.findByLabelText('Район');
    expect(screen.getByText('Адрес доставки')).toBeInTheDocument();
    const group = screen.getByRole('group', {
      name: `Демо центральная зона — доставка 15${NB}000${NB}сум`,
    });
    expect(within(group).getByRole('option', { name: 'Юнусабад' })).toBeInTheDocument();
  });
});

describe('CheckoutView: the form', () => {
  it('preselects nothing, prefills the name and the +998 prefix, and sets mobile input hints', async () => {
    renderCheckout();
    await loaded();

    expect(screen.getByLabelText('Tuman')).toHaveValue('');
    expect(screen.getByLabelText('Ism')).toHaveValue('Ali Valiyev');
    expect(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Yetkazilganda karta orqali' })).not.toBeChecked();

    const phone = screen.getByLabelText('Telefon raqami');
    expect(phone).toHaveValue('+998 ');
    expect(phone).toHaveAttribute('type', 'tel');
    expect(phone).toHaveAttribute('inputmode', 'tel');
    expect(phone).toHaveAttribute('autocomplete', 'tel');
    expect(phone).toHaveAttribute('enterkeyhint', 'next');
    expect(screen.getByLabelText('Ism')).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByLabelText('Ko‘cha')).toHaveAttribute('autocomplete', 'address-line1');
  });

  it('groups deliverable districts by zone with the fee, and lists no other districts', async () => {
    renderCheckout();
    await loaded();
    const groups = screen.getAllByRole('group').filter((el) => el.tagName === 'OPTGROUP');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      `Demo markaziy zona — yetkazish 15${NB}000${NB}so‘m`,
      'Demo chekka zona — yetkazish Bepul',
    ]);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Tumanni tanlang', 'Yunusobod', 'Mirobod', 'Chilonzor']);
  });

  it('caps every field at the server limit and wraps long user text', async () => {
    renderCheckout();
    await loaded();
    expect(screen.getByLabelText('Ko‘cha')).toHaveAttribute('maxlength', '200');
    expect(screen.getByLabelText('Uy')).toHaveAttribute('maxlength', '32');
    expect(screen.getByLabelText(/Xonadon/)).toHaveAttribute('maxlength', '16');
    expect(screen.getByLabelText(/Qavat/)).toHaveAttribute('maxlength', '8');
    expect(screen.getByLabelText('Ism')).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText(/Kuryer uchun izoh/)).toHaveAttribute('maxlength', '500');
    // Every control can shrink inside a grid cell (min-w-0) and user text may break anywhere.
    for (const label of ['Ko‘cha', 'Uy', 'Ism', 'Telefon raqami']) {
      const input = screen.getByLabelText(label);
      expect(input.className).toContain('min-w-0');
      expect(input).toHaveAttribute('data-user-text');
    }
  });

  it('keeps worst-case user text intact in the fields', async () => {
    renderCheckout();
    await loaded();
    type('Ko‘cha', WORST.street);
    type(/Mo‘ljal/, WORST.landmark);
    type('Ism', WORST.recipientName);
    type(/Kuryer uchun izoh/, WORST.comment);
    expect(screen.getByLabelText('Ko‘cha')).toHaveValue(WORST.street);
    expect(screen.getByLabelText('Ism')).toHaveValue(WORST.recipientName);
    expect(screen.getByText('500/500')).toBeInTheDocument();
  });

  it('shows validation errors per field after a submit attempt and focuses the first', async () => {
    renderCheckout();
    await loaded();
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByLabelText('Tuman')).toHaveFocus());
    expect(orderPosts()).toHaveLength(0);
    expect(screen.getByLabelText('Tuman')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Ko‘cha')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('To‘ldirish shart').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByLabelText('Ko‘cha')).toHaveAccessibleDescription('To‘ldirish shart');
    expect(screen.getByRole('group', { name: 'To‘lov usuli' })).toHaveAccessibleDescription(
      /To‘ldirish shart/,
    );

    type('Telefon raqami', '+998 00 12');
    fireEvent.blur(screen.getByLabelText('Telefon raqami'));
    expect(screen.getByText(/\+998 XX XXX XX XX/)).toBeInTheDocument();
  });

  it('reports a malformed value once the field is left, but "required" only after a submit', async () => {
    renderCheckout();
    await loaded();
    // Leaving an empty field must not insert an error row (it could shift the next tap target).
    fireEvent.blur(screen.getByLabelText('Ko‘cha'));
    expect(screen.queryByText('To‘ldirish shart')).toBeNull();
    // A value that is present but wrong is reported straight away.
    type('Ko‘cha', 'a');
    fireEvent.blur(screen.getByLabelText('Ko‘cha'));
    expect(screen.getByText('Kamida 2 ta belgi kiriting')).toBeInTheDocument();
  });
});

describe('CheckoutView: quote', () => {
  it('prices the cart for the chosen district and shows the server totals', async () => {
    renderCheckout();
    await loaded();
    expect(screen.getByTestId('checkout-total').textContent).toBe('—');
    expect(screen.getByTestId('checkout-delivery')).toHaveTextContent('Tumanni tanlang');

    await pickDistrict('yunusobod');
    const request = calls('POST', '/checkout/quote')[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ district: 'yunusobod' });
    expect(screen.getByTestId('checkout-subtotal').textContent).toBe(uzs(60000));
    expect(screen.getByTestId('checkout-delivery').textContent).toBe(uzs(15000));
    expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(75000));
    expect(screen.getByTestId('free-delivery-hint').textContent).toBe(
      `Bepul yetkazish uchun yana 240${NB}000${NB}so‘m qo‘shing`,
    );
    expect(screen.getAllByTestId('summary-line')).toHaveLength(1);
    expect(screen.getByText('4 ta mahsulot')).toBeInTheDocument();
  });

  it('shows "Bepul" when the delivery fee is 0, never "0 so‘m"', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(quote({ delivery_fee_uzs: 0, total_uzs: 60000, free_delivery_remaining_uzs: 0 }));
    renderCheckout();
    await loaded();
    await pickDistrict();
    expect(screen.getByTestId('checkout-delivery').textContent).toBe('Bepul');
    expect(screen.getByText('Yetkazib berish bepul')).toBeInTheDocument();
  });

  it('shows "Бесплатно" in Russian', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(quote({ delivery_fee_uzs: 0, total_uzs: 60000, free_delivery_remaining_uzs: null }));
    renderCheckout('ru');
    await screen.findByLabelText('Район');
    fireEvent.change(screen.getByLabelText('Район'), { target: { value: 'yunusobod' } });
    await waitFor(() =>
      expect(screen.getByTestId('checkout-delivery').textContent).toBe('Бесплатно'),
    );
  });

  it('re-quotes when the district changes and ignores a slow answer for the old one', async () => {
    let releaseFirst: (response: Response) => void = () => undefined;
    let n = 0;
    routes['POST /checkout/quote'] = (init) => {
      n += 1;
      if (n === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve));
      const { district } = JSON.parse(String(init.body)) as { district: string };
      return respond(
        quote({
          zone: farZone(),
          delivery_fee_uzs: 0,
          total_uzs: 111000,
          issues: [],
          can_place_order: true,
          subtotal_uzs: 111000,
          free_delivery_remaining_uzs: null,
          ...(district === '' ? {} : {}),
        }),
      );
    };
    renderCheckout();
    await loaded();
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'yunusobod' } });
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'chilonzor' } });
    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(111000)));

    await act(async () => {
      releaseFirst(respond(quote({ total_uzs: 75000 })));
    });
    expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(111000));
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
  });

  it('reports the minimum order and blocks submitting', async () => {
    renderCheckout();
    await loaded();
    await pickDistrict('chilonzor');
    expect(screen.getByTestId('below-min').textContent).toContain(
      `minimal buyurtma: 100${NB}000${NB}so‘m`,
    );
    expect(submitButton()).toBeDisabled();
  });

  it('flags lines that cannot be bought and links back to the cart', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(
        quote({
          items: [line({ issue: 'product_inactive' })],
          issues: ['cart_has_issues'],
          can_place_order: false,
        }),
      );
    renderCheckout();
    await loaded();
    await pickDistrict();
    expect(screen.getByTestId('cart-issues')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Savatga qaytish' })).toHaveAttribute(
      'href',
      '/uz/cart',
    );
    expect(submitButton()).toBeDisabled();
  });

  it('notes that a closed zone still takes the order, with the opening time', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(quote({ zone: zone({ is_open_now: false, opens_at: '09:00' }) }));
    renderCheckout();
    await loaded();
    await pickDistrict();
    expect(screen.getByTestId('zone-closed')).toHaveTextContent(
      'Buyurtma qabul qilinadi va 09:00 dan boshlab yetkaziladi.',
    );
    expect(submitButton()).toBeEnabled();
  });

  it('shows the zone hours, minimum and free-delivery threshold under the select', async () => {
    renderCheckout();
    await loaded();
    await pickDistrict();
    const description = screen.getByLabelText('Tuman').getAttribute('aria-describedby') ?? '';
    const hint = document.getElementById(description.split(' ').pop() ?? '');
    expect(hint).toHaveTextContent('09:00–21:00');
    expect(hint?.textContent).toContain(`Minimal buyurtma: 50${NB}000${NB}so‘m`);
    expect(hint?.textContent).toContain(`300${NB}000${NB}so‘m dan boshlab yetkazish bepul`);
  });

  it('says so when the district cannot be served and keeps the form usable', async () => {
    routes['POST /checkout/quote'] = () => apiError('district_not_served', 409);
    renderCheckout();
    await loaded();
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'yunusobod' } });
    expect(
      await screen.findByText('Bu tumanga yetkazib berilmaydi. Boshqa tuman tanlang.'),
    ).toBeInTheDocument();
  });
});

describe('CheckoutView: placing the order (browser)', () => {
  it('sends the idempotent request, then replaces the page with the order and ?placed=1', async () => {
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());

    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(nav.replace).toHaveBeenCalledWith(`/uz/orders/${order().id}?placed=1`);
    expect(orderPosts()).toHaveLength(1);
    const init = orderPosts()[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(isValidIdempotencyKey(keyOf(0) ?? '')).toBe(true);
    expect(bodyOf(0)).toEqual({
      address: { district: 'yunusobod', street: 'Demo ko‘cha', house: '12' },
      recipient_name: 'Ali Valiyev',
      recipient_phone: '+998001234567',
      payment_method: 'cash_on_delivery',
      expected_total_uzs: 75000,
    });
  });

  it('sends optional fields and the comment when they are filled in', async () => {
    renderCheckout();
    await loaded();
    await fillValid();
    type(/Xonadon/, '34');
    type(/Kirish/, '2');
    type(/Qavat/, '5');
    type(/Mo‘ljal/, 'Metro');
    type(/Kuryer uchun izoh/, 'Eshik oldiga qoldiring');
    fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda karta orqali' }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0)).toMatchObject({
      address: {
        district: 'yunusobod',
        street: 'Demo ko‘cha',
        house: '12',
        apartment: '34',
        entrance: '2',
        floor: '5',
        landmark: 'Metro',
      },
      payment_method: 'card_on_delivery',
      comment: 'Eshik oldiga qoldiring',
    });
  });

  it('blocks a double submit and disables the button while the request is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    routes['POST /orders'] = () => new Promise<Response>((resolve) => (release = resolve));
    renderCheckout();
    await loaded();
    await fillValid();

    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(submitButton()).toHaveTextContent('Yuborilmoqda…');
    fireEvent.click(submitButton());
    fireEvent.submit(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }));
    expect(orderPosts()).toHaveLength(1);

    await act(async () => {
      release(respond(order(), 201));
    });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(orderPosts()).toHaveLength(1);
  });

  it('keeps everything filled in after a network failure and retries with the SAME key', async () => {
    routes['POST /orders'] = () => {
      throw ApiRequestError.network();
    };
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());

    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveAttribute('data-failure', 'network');
    expect(failure).toHaveTextContent('Internet aloqasi yo‘q');
    expect(screen.getByLabelText('Ko‘cha')).toHaveValue('Demo ko‘cha');
    expect(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' })).toBeChecked();
    expect(nav.replace).not.toHaveBeenCalled();

    routes['POST /orders'] = () => respond(order(), 200, { 'Idempotent-Replayed': 'true' });
    fireEvent.click(within(failure).getByRole('button', { name: 'Qayta urinish' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    // The API answered with the order the first attempt had created: "we found your order".
    expect(nav.replace).toHaveBeenCalledWith(`/uz/orders/${order().id}?placed=found`);
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  it('retries a server error with the same key, and uses a new key once the body changed', async () => {
    routes['POST /orders'] = () => apiError('internal_error', 500);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByTestId('submit-failure')).toHaveAttribute('data-failure', 'server');

    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(2));
    expect(keyOf(1)).toBe(keyOf(0));

    await waitFor(() => expect(submitButton()).toBeEnabled());
    type('Ko‘cha', 'Boshqa ko‘cha');
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(bodyOf(2).address.street).toBe('Boshqa ko‘cha');
  });

  it('shows old and new total on price_changed and needs an explicit confirm with a new key', async () => {
    let first = true;
    let priceMoved = false;
    routes['POST /checkout/quote'] = () =>
      respond(priceMoved ? quote({ total_uzs: 81000, delivery_fee_uzs: 21000 }) : quote());
    routes['POST /orders'] = (init) => {
      if (first) {
        first = false;
        priceMoved = true;
        return apiError('price_changed', 409, { total_uzs: 81000 });
      }
      return respond(
        order({
          total_uzs: (JSON.parse(String(init.body)) as { expected_total_uzs: number })
            .expected_total_uzs,
        }),
        201,
      );
    };
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());

    const notice = await screen.findByTestId('price-changed');
    expect(within(notice).getByTestId('price-was').textContent).toBe(uzs(75000));
    expect(within(notice).getByTestId('price-now').textContent).toBe(uzs(81000));
    // Nothing is sent on the customer's behalf.
    expect(orderPosts()).toHaveLength(1);
    expect(nav.replace).not.toHaveBeenCalled();
    // The main button now says what pressing it does.
    expect(submitButton().textContent).toBe('Yangi summani tasdiqlash');
    expect(within(screen.getByTestId('submit-bar')).getByTestId('bar-total').textContent).toBe(
      uzs(81000),
    );

    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(81000)));
    fireEvent.click(within(notice).getByRole('button', { name: 'Yangi summani tasdiqlash' }));

    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(orderPosts()).toHaveLength(2);
    expect(bodyOf(1).expected_total_uzs).toBe(81000);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('requires a confirm when the quote refreshed before submitting has a different total', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    renderCheckout();
    await loaded();
    await fillValid();
    expect(calls('POST', '/checkout/quote')).toHaveLength(1);

    // The quote on screen is now stale; prices moved in the meantime.
    offset = 61_000;
    routes['POST /checkout/quote'] = () =>
      respond(quote({ total_uzs: 78000, delivery_fee_uzs: 18000 }));
    fireEvent.click(submitButton());

    const notice = await screen.findByTestId('price-changed');
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
    expect(within(notice).getByTestId('price-was').textContent).toBe(uzs(75000));
    expect(within(notice).getByTestId('price-now').textContent).toBe(uzs(78000));
    expect(orderPosts()).toHaveLength(0);
  });

  it('does not re-quote when the quote is still fresh', async () => {
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(calls('POST', '/checkout/quote')).toHaveLength(1);
  });

  it('explains insufficient stock and links back to the cart', async () => {
    routes['POST /orders'] = () =>
      apiError('insufficient_stock', 409, { available_quantity: 2, product_id: 'p1' });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveTextContent('Omborda yetarli emas. Mavjud: 2. Savatni o‘zgartiring.');
    expect(within(failure).getByRole('link', { name: 'Savatga o‘tish' })).toHaveAttribute(
      'href',
      '/uz/cart',
    );
    // The summary is refreshed from the server after the failure.
    await waitFor(() => expect(calls('POST', '/checkout/quote').length).toBeGreaterThanOrEqual(2));
  });

  it('explains too many open orders and links to the order history', async () => {
    routes['POST /orders'] = () => apiError('too_many_open_orders', 409);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveAttribute('data-failure', 'too_many_open_orders');
    expect(failure).toHaveTextContent('Sizda tasdiqlanmagan buyurtmalar ko‘p.');
    expect(within(failure).getByRole('link', { name: 'Buyurtmalarimga o‘tish' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    expect(screen.getByLabelText('Ko‘cha')).toHaveValue('Demo ko‘cha');
  });

  it('explains an inactive product and links back to the cart', async () => {
    routes['POST /orders'] = () => apiError('product_inactive', 409, { product_id: 'p1' });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveTextContent('endi sotuvda yo‘q');
    expect(within(failure).getByRole('link', { name: 'Savatga o‘tish' })).toBeInTheDocument();
  });

  it('shows server validation errors on the fields they belong to and focuses the first', async () => {
    routes['POST /orders'] = () =>
      apiError('validation_error', 422, {
        details: [
          { loc: ['body', 'recipient_phone'], msg: 'bad phone' },
          { loc: ['body', 'address', 'street'], msg: 'bad street' },
        ],
      });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByLabelText('Ko‘cha')).toHaveFocus());
    expect(screen.getByLabelText('Ko‘cha')).toHaveAccessibleDescription('Maydonni tekshiring');
    expect(screen.getByLabelText('Telefon raqami')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Uy')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('submit-failure')).toHaveTextContent(
      'Ba’zi maydonlarni to‘g‘rilang.',
    );

    // Editing the field clears its server error.
    type('Ko‘cha', 'Yangi ko‘cha');
    expect(screen.getByLabelText('Ko‘cha')).not.toHaveAttribute('aria-invalid');
  });

  it('waits out a rate limit: shows the seconds and disables the button', async () => {
    routes['POST /orders'] = () => apiError('rate_limited', 429, {}, { 'Retry-After': '7' });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveTextContent('Juda ko‘p urinish. 7 soniyadan keyin qayta urinib ko‘ring.');
    expect(submitButton()).toBeDisabled();
    expect(within(failure).getByRole('button', { name: 'Qayta urinish' })).toBeDisabled();
  });

  it('asks the session layer to re-establish the session and keeps the form', async () => {
    routes['POST /orders'] = () => apiError('session_required', 401);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByTestId('submit-failure')).toHaveAttribute('data-failure', 'session');
    expect(session.retry).toHaveBeenCalled();
    expect(screen.getByLabelText('Ko‘cha')).toHaveValue('Demo ko‘cha');
  });

  it('recovers from an idempotency key conflict with a fresh key', async () => {
    let first = true;
    routes['POST /orders'] = () => {
      if (first) {
        first = false;
        return apiError('idempotency_key_conflict', 409);
      }
      return respond(order(), 201);
    };
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await screen.findByTestId('submit-failure');
    fireEvent.click(submitButton());
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});

describe('CheckoutView: an attempt that outlives a reload (sessionStorage)', () => {
  const ATTEMPT = 'mm.checkoutAttempt';
  const emptyCart = () => cart({ items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0 });
  const ordersPage = (items: unknown[]) =>
    respond({ items, page: 1, page_size: 5, total: items.length, total_pages: 1 });
  const summaryOf = (overrides: Record<string, unknown> = {}) => ({
    id: order().id,
    number: order().number,
    status: 'NEW',
    created_at: new Date().toISOString(),
    item_count: 4,
    total_uzs: 75000,
    ...overrides,
  });

  /** Places an attempt that times out, then "reloads" the page. */
  async function timeOutThenReload() {
    routes['POST /orders'] = () => {
      throw ApiRequestError.network();
    };
    const first = renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await screen.findByTestId('submit-failure');
    first.unmount();
  }

  it('retries the same body after a reload with the SAME key', async () => {
    await timeOutThenReload();
    const stored = window.sessionStorage.getItem(ATTEMPT) ?? '';
    expect(JSON.parse(stored)).toMatchObject({ key: keyOf(0), owner: USER_ID, totalUzs: 75000 });
    // The stored attempt carries no personal data: only a hash of the body.
    expect(stored).not.toContain('998001234567');
    expect(stored).not.toContain('Demo');

    routes['POST /orders'] = () => respond(order(), 200, { 'Idempotent-Replayed': 'true' });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(nav.replace).toHaveBeenCalledWith(`/uz/orders/${order().id}?placed=found`);
    // An order exists now: nothing is left to retry.
    expect(window.sessionStorage.getItem(ATTEMPT)).toBeNull();
  });

  it('uses a new key after a reload when the body changed, and stores that one instead', async () => {
    await timeOutThenReload();
    routes['POST /orders'] = () => respond(order(), 201);
    renderCheckout();
    await loaded();
    await fillValid();
    type('Uy', '14');
    fireEvent.click(submitButton());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(nav.replace).toHaveBeenCalledWith(`/uz/orders/${order().id}?placed=1`);
    expect(window.sessionStorage.getItem(ATTEMPT)).toBeNull();
  });

  it('starts over with a fresh key after idempotency_key_conflict', async () => {
    await timeOutThenReload();
    routes['POST /orders'] = () => apiError('idempotency_key_conflict', 409);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await screen.findByTestId('submit-failure');
    expect(keyOf(1)).toBe(keyOf(0));
    expect(window.sessionStorage.getItem(ATTEMPT)).toBeNull();

    routes['POST /orders'] = () => respond(order(), 201);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it("does not reuse another account's attempt in the same tab", async () => {
    await timeOutThenReload();
    session.user = {
      id: 'b0b0b0b0-0000-4000-8000-000000000000',
      first_name: 'Ali',
      last_name: 'Valiyev',
    };
    routes['POST /orders'] = () => respond(order(), 201);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(2));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('says "we found your order" when the cart comes back empty after the reload', async () => {
    await timeOutThenReload();
    // The first request had reached the server: the order took the cart's items.
    routes['GET /cart'] = () => respond(emptyCart());
    routes['GET /orders?page_size=5'] = () =>
      ordersPage([summaryOf(), summaryOf({ id: 'older', total_uzs: 12000 })]);
    renderCheckout();

    const recovered = await screen.findByTestId('recovered-order');
    expect(recovered).toHaveAttribute('role', 'status');
    expect(recovered).toHaveTextContent('Buyurtmangizni topdik');
    expect(recovered).toHaveTextContent('№ MM-000123 buyurtma rasmiylashtirildi');
    expect(within(recovered).getByRole('link', { name: 'Buyurtmani ochish' })).toHaveAttribute(
      'href',
      `/uz/orders/${order().id}?placed=found`,
    );
    expect(screen.queryByText('Savatingiz bo‘sh')).toBeNull();
    expect(window.sessionStorage.getItem(ATTEMPT)).toBeNull();
  });

  it('speaks Russian', async () => {
    await timeOutThenReload();
    routes['GET /cart'] = () => respond(emptyCart());
    routes['GET /orders?page_size=5'] = () => ordersPage([summaryOf()]);
    renderCheckout('ru');
    const recovered = await screen.findByTestId('recovered-order');
    expect(recovered).toHaveTextContent('Мы нашли ваш заказ');
    expect(recovered).toHaveTextContent('заказ № MM-000123 оформлен');
    expect(within(recovered).getByRole('link', { name: 'Открыть заказ' })).toBeInTheDocument();
  });

  it('shows the plain empty cart when no matching order exists, and forgets the attempt', async () => {
    await timeOutThenReload();
    routes['GET /cart'] = () => respond(emptyCart());
    routes['GET /orders?page_size=5'] = () => ordersPage([summaryOf({ total_uzs: 12000 })]);
    renderCheckout();
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(screen.queryByTestId('recovered-order')).toBeNull();
    expect(window.sessionStorage.getItem(ATTEMPT)).toBeNull();
  });

  it('keeps the attempt when the order list cannot be loaded (the next visit asks again)', async () => {
    await timeOutThenReload();
    routes['GET /cart'] = () => respond(emptyCart());
    routes['GET /orders?page_size=5'] = () => apiError('internal_error', 500);
    renderCheckout();
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(ATTEMPT)).not.toBeNull();
  });

  it('does not look for an order without a pending attempt', async () => {
    routes['GET /cart'] = () => respond(emptyCart());
    renderCheckout();
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(calls('GET', '/orders?page_size=5')).toHaveLength(0);
  });
});

describe('CheckoutView: submit control', () => {
  it('renders a sticky bottom bar in a browser, padded by the safe-area inset, with the total', async () => {
    renderCheckout();
    await loaded();
    const bar = screen.getByTestId('submit-bar');
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('bottom-0');
    expect(bar.className).toContain('pb-[env(safe-area-inset-bottom');
    expect(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }).className).toContain(
      'safe-area-inset-bottom',
    );
    expect(submitButton()).toHaveTextContent('Buyurtma berish');
    expect(within(bar).queryByTestId('bar-total')).toBeNull();

    await pickDistrict();
    expect(within(bar).getByTestId('bar-total').textContent).toBe(uzs(75000));
    expect(submitButton().textContent).toBe('Buyurtma berish');
    expect(submitButton().className).toContain('active:scale');
  });
});

describe('CheckoutView in the Telegram Mini App', () => {
  it('drives submit with the MainButton: disabled until valid, progress while sending, no bar', async () => {
    const { webApp, state } = trackedWebApp();
    let release: (response: Response) => void = () => undefined;
    routes['POST /orders'] = () => new Promise<Response>((resolve) => (release = resolve));
    renderCheckout();
    await loaded();

    expect(screen.queryByTestId('submit-bar')).toBeNull();
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.text).toBe('Buyurtma berish');
    expect(state.disabled).toBe(true);
    expect(screen.getByTestId('fix-fields')).toBeInTheDocument();

    await fillValid();
    await waitFor(() => expect(state.disabled).toBe(false));
    expect(state.text).toBe(`Buyurtma berish — 75${NB}000${NB}so‘m`);
    expect(screen.queryByTestId('fix-fields')).toBeNull();

    act(() => pressMainButton(webApp));
    await waitFor(() => expect(state.progress).toBe(true));
    expect(state.disabled).toBe(true);
    expect(orderPosts()).toHaveLength(1);

    await act(async () => {
      release(respond(order(), 201));
    });
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith(`/uz/orders/${order().id}?placed=1`),
    );
    expect(webApp.HapticFeedback?.notificationOccurred).toHaveBeenCalledWith('success');
  });

  it('refuses a second MainButton tap in the same tick (synchronous guard, not just state)', async () => {
    const { webApp, state } = trackedWebApp();
    let release: (response: Response) => void = () => undefined;
    routes['POST /orders'] = () => new Promise<Response>((resolve) => (release = resolve));
    renderCheckout();
    await loaded();
    await fillValid();
    await waitFor(() => expect(state.disabled).toBe(false));

    await act(async () => {
      pressMainButton(webApp);
      pressMainButton(webApp);
      pressMainButton(webApp);
    });
    expect(orderPosts()).toHaveLength(1);
    await act(async () => {
      release(respond(order(), 201));
    });
  });

  it('keeps the MainButton disabled while the order cannot be placed', async () => {
    const { state } = trackedWebApp();
    renderCheckout();
    await loaded();
    await pickDistrict('chilonzor');
    type('Ko‘cha', 'Demo ko‘cha');
    type('Uy', '1');
    type('Telefon raqami', '+998001234567');
    fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
    await waitFor(() => expect(screen.getByTestId('below-min')).toBeInTheDocument());
    expect(state.disabled).toBe(true);
  });

  it('switches the MainButton to the confirm action after a price change, and haptics report errors', async () => {
    const { webApp, state } = trackedWebApp();
    let first = true;
    let priceMoved = false;
    routes['POST /checkout/quote'] = () =>
      respond(priceMoved ? quote({ total_uzs: 81000, delivery_fee_uzs: 21000 }) : quote());
    routes['POST /orders'] = () => {
      if (first) {
        first = false;
        priceMoved = true;
        return apiError('price_changed', 409, { total_uzs: 81000 });
      }
      return respond(order(), 201);
    };
    renderCheckout();
    await loaded();
    await fillValid();
    await waitFor(() => expect(state.disabled).toBe(false));
    act(() => pressMainButton(webApp));

    await screen.findByTestId('price-changed');
    await waitFor(() => expect(state.text).toBe(`Yangi summani tasdiqlash — 81${NB}000${NB}so‘m`));
    expect(webApp.HapticFeedback?.notificationOccurred).toHaveBeenCalledWith('error');

    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(81000)));
    await waitFor(() => expect(state.disabled).toBe(false));
    act(() => pressMainButton(webApp));
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(bodyOf(1).expected_total_uzs).toBe(81000);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('releases the MainButton when the page is left', async () => {
    const { webApp } = trackedWebApp();
    const { unmount } = renderCheckout();
    await loaded();
    unmount();
    expect(webApp.MainButton.hide).toHaveBeenCalled();
    expect(webApp.MainButton.offClick).toHaveBeenCalled();
  });
});

describe('CheckoutView: worst-case data (break-ui)', () => {
  function manyLines(count: number, name: (index: number) => { uz: string; ru: string }) {
    return Array.from({ length: count }, (_, index) => {
      const { uz, ru } = name(index);
      return line({
        product: product({
          id: `p${String(index)}`,
          slug: `demo-${String(index)}`,
          name_uz: uz,
          name_ru: ru,
        }),
        quantity: 99,
        line_total_uzs: 99 * 15000,
      });
    });
  }

  it('renders 50 lines with 255-character names and a 10-digit total without truncating money', async () => {
    const items = manyLines(50, () => ({ uz: WORST.productNameUz, ru: WORST.productNameRu }));
    routes['GET /cart'] = () => respond(cart({ items, item_count: 4950 }));
    routes['POST /checkout/quote'] = () =>
      respond(
        quote({
          items,
          item_count: 4950,
          subtotal_uzs: WORST.hugeTotal,
          delivery_fee_uzs: 0,
          total_uzs: WORST.hugeTotal,
          free_delivery_remaining_uzs: 0,
        }),
      );
    renderCheckout();
    await loaded();
    await pickDistrict();

    expect(screen.getAllByTestId('summary-line')).toHaveLength(50);
    const firstName = screen.getAllByTestId('summary-line')[0]?.querySelector('p');
    expect(firstName?.textContent).toBe(WORST.productNameUz);
    expect(firstName?.className).toContain('[overflow-wrap:anywhere]');

    const total = screen.getByTestId('checkout-total');
    expect(total.textContent).toBe('9 999 999 000 so‘m');
    expect(total).toHaveAttribute('data-money');
    expect(total.className).toContain('shrink-0');
    expect(screen.getByTestId('bar-total').textContent).toBe(total.textContent);
    expect(document.querySelector('.truncate, [class*="line-clamp"]')).toBeNull();
    expect(screen.getByText('4950 ta mahsulot')).toBeInTheDocument();
  });

  it('renders Cyrillic 255-character names and Russian plurals (1, 2, 5, 21)', async () => {
    const items = manyLines(1, () => ({ uz: 'x', ru: WORST.productNameRu }));
    routes['GET /cart'] = () => respond(cart({ items, item_count: 1 }));
    const counts = new Map([
      [1, '1 товар'],
      [2, '2 товара'],
      [5, '5 товаров'],
      [21, '21 товар'],
    ]);
    for (const [count, text] of counts) {
      routes['POST /checkout/quote'] = () => respond(quote({ items, item_count: count }));
      const { unmount } = renderCheckout('ru');
      await screen.findByLabelText('Район');
      fireEvent.change(screen.getByLabelText('Район'), { target: { value: 'yunusobod' } });
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
      session.apiFetch.mockClear();
    }
  });

  it('uses the singular for exactly one item in Uzbek too (no "1 mahsulotlar")', async () => {
    routes['POST /checkout/quote'] = () => respond(quote({ item_count: 1 }));
    renderCheckout();
    await loaded();
    await pickDistrict();
    expect(screen.getByText('1 ta mahsulot')).toBeInTheDocument();
  });

  it('survives a 100-character Cyrillic recipient name from the session', async () => {
    session.user = {
      id: USER_ID,
      first_name: WORST.recipientName.split(' ')[0] ?? '',
      last_name: WORST.recipientName.split(' ').slice(1).join(' '),
    };
    renderCheckout();
    await loaded();
    const value = (screen.getByLabelText('Ism') as HTMLInputElement).value;
    expect(Array.from(value).length).toBeLessThanOrEqual(100);
    expect(value.startsWith('Александра')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Delivery slots. The zone with slots is `demo-chekka` (district chilonzor, plus olmazor here so a
// district change inside one zone can be tested); the zone without slots is yunusobod's.
// ---------------------------------------------------------------------------------------------

const SLOT = {
  todayLow: '5a000000-0000-4000-8000-000000000001',
  todayFull: '5a000000-0000-4000-8000-000000000002',
  tomorrow: '5a000000-0000-4000-8000-000000000003',
  later: '5a000000-0000-4000-8000-000000000004',
} as const;

/** A quote for the slot zone: clears the 100 000 minimum, so only the slot can block the order. */
function chekkaQuote(overrides: Parameters<typeof slotQuote>[0] = {}) {
  return slotQuote({
    zone: farZone(),
    subtotal_uzs: 120000,
    delivery_fee_uzs: 0,
    total_uzs: 120000,
    free_delivery_remaining_uzs: null,
    ...overrides,
  });
}

function chekkaZone() {
  return zone({
    ...farZone(),
    districts: [
      { code: 'chilonzor', name_uz: 'Chilonzor', name_ru: 'Чиланзар' },
      { code: 'olmazor', name_uz: 'Olmazor', name_ru: 'Олмазор' },
    ],
  });
}

const slotGroup = () => screen.getByRole('radiogroup', { name: 'Yetkazish vaqti' });
const slotTile = (id: string) =>
  screen
    .getAllByTestId('delivery-slot-option')
    .find((element) => element.getAttribute('data-slot-id') === id) as HTMLElement;
const dayTab = (date: string) =>
  screen
    .getAllByRole('tab')
    .find((element) => element.getAttribute('data-date') === date) as HTMLElement;
/** Like a customer: open the window's day first when another day is shown, then tap the window. */
const pickSlot = (id: string) => {
  const tile = slotTile(id);
  const date = tile.closest('[data-day]')?.getAttribute('data-day');
  if (date !== null && date !== undefined) {
    if (screen.getByRole('tabpanel').getAttribute('data-day') !== date)
      fireEvent.click(dayTab(date));
  }
  fireEvent.click(tile);
};
const checkedSlots = () =>
  screen.queryAllByRole('radio', { name: /\d\d:\d\d–\d\d:\d\d/ }).filter((radio) => {
    return (radio as HTMLInputElement).checked;
  });

/** District picked, then everything else a valid order needs, except the delivery window. */
async function fillValidForSlotZone(district: DistrictCode = 'chilonzor') {
  await pickDistrict(district);
  type('Ko‘cha', 'Demo ko‘cha');
  type('Uy', '12');
  type('Telefon raqami', '+998 00 123-45-67');
  fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
}

describe('CheckoutView: delivery slots', () => {
  beforeEach(() => {
    // 10:00 in Tashkent on 31 October 2026. Only `Date` is faked, so waitFor keeps working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T05:00:00Z'));
    routes['GET /delivery/zones'] = () =>
      respond({ items: [zone(), chekkaZone()], timezone: 'Asia/Tashkent' });
    routes['POST /checkout/quote'] = (init) => {
      const { district } = JSON.parse(String(init.body)) as { district: DistrictCode };
      return respond(district === 'yunusobod' ? quote() : chekkaQuote());
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no picker for a zone without slots, and sends no slot', async () => {
    renderCheckout();
    await loaded();
    await fillValid();
    expect(screen.queryByTestId('delivery-slots')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Yetkazish vaqti' })).toBeNull();
    expect(screen.queryByTestId('submit-reason')).toBeNull();
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0)).not.toHaveProperty('delivery_slot_id');
  });

  it('shows the picker once the district is chosen, grouped by day with full windows disabled', async () => {
    renderCheckout();
    await loaded();
    expect(screen.queryByTestId('delivery-slots')).toBeNull();
    await pickDistrict('chilonzor');

    expect(slotGroup()).toBeInTheDocument();
    const days = screen.getAllByRole('tab');
    expect(days.map((day) => day.getAttribute('data-date'))).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-03',
    ]);
    expect(days[0]).toHaveTextContent('Bugun');
    expect(days[1]).toHaveTextContent('Ertaga');
    expect(days[2]).toHaveTextContent('Seshanba');
    // The first day with a free window is shown; the others' windows are one tap away.
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-day', '2026-10-31');
    expect(
      screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' }),
    ).toHaveAccessibleDescription('2 ta joy qoldi');
    const full = screen.getByRole('radio', { name: 'Bugun, 31.10, 12:00–14:00' });
    expect(full).toBeDisabled();
    expect(full).toHaveAccessibleDescription('To‘lgan');
    // Nothing is preselected: the customer chooses.
    expect(checkedSlots()).toHaveLength(0);
  });

  it('blocks submitting until a window is chosen, and says why next to the button', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();

    expect(submitButton()).toBeDisabled();
    const reason = screen.getByTestId('submit-reason');
    expect(reason).toHaveTextContent('Buyurtma berish uchun yetkazish vaqtini tanlang.');
    expect(submitButton()).toHaveAccessibleDescription(reason.textContent ?? '');
    fireEvent.submit(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }));
    expect(orderPosts()).toHaveLength(0);

    pickSlot(SLOT.tomorrow);
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByTestId('submit-reason')).toBeNull();
  });

  it('refuses to pick a full window', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.todayFull);
    expect(checkedSlots()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it('sends the chosen window as delivery_slot_id, and shows it in the summary', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);
    expect(screen.getByTestId('checkout-slot-summary')).toHaveTextContent(
      'Yetkazish vaqtiErtaga, 01.11 · 10:00–12:00',
    );
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeChecked();

    fireEvent.click(submitButton());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(orderPosts()).toHaveLength(1);
    expect(bodyOf(0)).toEqual({
      address: { district: 'chilonzor', street: 'Demo ko‘cha', house: '12' },
      recipient_name: 'Ali Valiyev',
      recipient_phone: '+998001234567',
      payment_method: 'cash_on_delivery',
      delivery_slot_id: SLOT.tomorrow,
      expected_total_uzs: 120000,
    });
  });

  it('keeps the idempotency key for the same window and changes it when the window changes', async () => {
    routes['POST /orders'] = () => apiError('internal_error', 500);
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);

    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    await screen.findByTestId('submit-failure');
    await waitFor(() => expect(submitButton()).toBeEnabled());

    // Same body again: a retry, so the same key.
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(2));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(bodyOf(1).delivery_slot_id).toBe(SLOT.tomorrow);

    // Another window is another order body: the server would answer 409 idempotency_key_conflict
    // for the old key, so it must be a new one.
    await waitFor(() => expect(submitButton()).toBeEnabled());
    pickSlot(SLOT.later);
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(3));
    expect(bodyOf(2).delivery_slot_id).toBe(SLOT.later);
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(isValidIdempotencyKey(keyOf(2) ?? '')).toBe(true);
  });

  it.each([
    ['slot_full', 'full', 'Bu vaqt oralig‘i to‘lib qoldi. Boshqa vaqtni tanlang.'],
    ['slot_unavailable', 'unavailable', 'Bu vaqt endi mavjud emas. Boshqa vaqtni tanlang.'],
    ['slot_required', 'required', 'Buyurtma berish uchun yetkazish vaqtini tanlang.'],
  ])(
    'on 409 %s: re-quotes, clears the choice, explains it by the picker and needs a new key',
    async (code, reason, message) => {
      let refused = true;
      routes['POST /orders'] = () => {
        if (refused) {
          refused = false;
          return apiError(code, 409);
        }
        return respond(order(), 201);
      };
      renderCheckout();
      await loaded();
      await fillValidForSlotZone();
      pickSlot(SLOT.tomorrow);
      const quotesBefore = calls('POST', '/checkout/quote').length;

      fireEvent.click(submitButton());
      const notice = await screen.findByTestId('slot-notice');
      expect(notice).toHaveAttribute('data-reason', reason);
      expect(notice).toHaveTextContent(message);
      // Next to the picker, not in the general failure area.
      expect(screen.getByTestId('delivery-slots')).toContainElement(notice);
      expect(screen.queryByTestId('submit-failure')).toBeNull();
      // Re-quoted, selection cleared, order blocked again.
      await waitFor(() =>
        expect(calls('POST', '/checkout/quote').length).toBeGreaterThan(quotesBefore),
      );
      await waitFor(() => expect(checkedSlots()).toHaveLength(0));
      expect(submitButton()).toBeDisabled();
      // The picker takes focus so a keyboard or screen-reader user lands on the problem.
      await waitFor(() => expect(slotGroup()).toHaveFocus());
      expect(orderPosts()).toHaveLength(1);

      // Choosing the very same window again must not reuse the refused request's key.
      pickSlot(SLOT.tomorrow);
      expect(screen.queryByTestId('slot-notice')).toBeNull();
      fireEvent.click(submitButton());
      await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
      expect(orderPosts()).toHaveLength(2);
      expect(bodyOf(1)).toEqual(bodyOf(0));
      expect(keyOf(1)).not.toBe(keyOf(0));
    },
  );

  it('offers the refreshed windows after slot_full (the full one is now disabled)', async () => {
    let refused = false;
    routes['POST /orders'] = () => {
      refused = true;
      return apiError('slot_full', 409);
    };
    routes['POST /checkout/quote'] = () =>
      respond(
        chekkaQuote(
          refused
            ? {
                delivery_slots: [
                  slotOption({
                    id: SLOT.tomorrow,
                    date: '2026-11-01',
                    is_full: true,
                    remaining: 0,
                  }),
                  slotOption({
                    id: SLOT.later,
                    date: '2026-11-03',
                    starts_at: '16:00',
                    ends_at: '18:00',
                  }),
                ],
              }
            : {},
        ),
      );
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);
    fireEvent.click(submitButton());
    await screen.findByTestId('slot-notice');
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeDisabled(),
    );
    expect(checkedSlots()).toHaveLength(0);
    expect(screen.queryByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeNull();
  });

  it('does not ask the server when the chosen window vanished from a stale quote', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);
    // The window disappears server-side, and the quote on screen is now older than a minute.
    routes['POST /checkout/quote'] = () =>
      respond(
        chekkaQuote({ delivery_slots: [slotOption({ id: SLOT.later, date: '2026-11-03' })] }),
      );
    vi.setSystemTime(new Date('2026-10-31T05:02:00Z'));

    fireEvent.click(submitButton());
    const notice = await screen.findByTestId('slot-notice');
    expect(notice).toHaveAttribute('data-reason', 'unavailable');
    expect(orderPosts()).toHaveLength(0);
    expect(checkedSlots()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it('says the window filled up when a stale quote shows the chosen window as full', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);
    routes['POST /checkout/quote'] = () =>
      respond(
        chekkaQuote({
          delivery_slots: [
            slotOption({ id: SLOT.tomorrow, date: '2026-11-01', is_full: true, remaining: 0 }),
          ],
        }),
      );
    vi.setSystemTime(new Date('2026-10-31T05:02:00Z'));
    fireEvent.click(submitButton());
    expect(await screen.findByTestId('slot-notice')).toHaveAttribute('data-reason', 'full');
    expect(orderPosts()).toHaveLength(0);
  });

  it('keeps the choice and the picker while the same zone is re-quoted for another district', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone('chilonzor');
    pickSlot(SLOT.tomorrow);

    let release: (response: Response) => void = () => undefined;
    routes['POST /checkout/quote'] = () => new Promise<Response>((resolve) => (release = resolve));
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'olmazor' } });

    // While the new quote is on its way the windows stay (dimmed and inert), so the list does not
    // vanish under the customer's finger.
    await waitFor(() =>
      expect(screen.getByTestId('delivery-slots')).toHaveAttribute('aria-busy', 'true'),
    );
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeChecked();
    for (const radio of screen.getAllByRole('radio', { name: /\d\d:\d\d–\d\d:\d\d/ })) {
      expect(radio).toBeDisabled();
    }
    await act(async () => {
      release(respond(chekkaQuote()));
    });
    await waitFor(() =>
      expect(screen.getByTestId('delivery-slots')).toHaveAttribute('aria-busy', 'false'),
    );
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeChecked();
    expect(submitButton()).toBeEnabled();
    expect(calls('POST', '/checkout/quote').at(-1)?.[1]?.body).toBe(
      JSON.stringify({ district: 'olmazor' }),
    );
  });

  it('clears a choice the new quote no longer offers', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone('chilonzor');
    pickSlot(SLOT.tomorrow);

    routes['POST /checkout/quote'] = () =>
      respond(
        chekkaQuote({
          delivery_slots: [slotOption({ id: SLOT.later, date: '2026-11-03', starts_at: '16:00' })],
        }),
      );
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'olmazor' } });
    await waitFor(() => expect(screen.getAllByTestId('delivery-slot-option')).toHaveLength(1));
    expect(checkedSlots()).toHaveLength(0);
    expect(screen.queryByTestId('checkout-slot-summary')).toBeNull();
    expect(submitButton()).toBeDisabled();
  });

  it('drops the picker and the choice when the district has no slots, and sends none', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone('chilonzor');
    pickSlot(SLOT.tomorrow);

    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'yunusobod' } });
    await waitFor(() => expect(screen.queryByTestId('delivery-slots')).toBeNull());
    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0)).not.toHaveProperty('delivery_slot_id');
    expect(bodyOf(0).address.district).toBe('yunusobod');
  });

  it('does not bring back a choice from another zone when the customer returns', async () => {
    renderCheckout();
    await loaded();
    await fillValidForSlotZone('chilonzor');
    pickSlot(SLOT.tomorrow);
    await pickDistrict('yunusobod');
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'chilonzor' } });
    await waitFor(() => expect(screen.getByTestId('delivery-slots')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('delivery-slots')).toHaveAttribute('aria-busy', 'false'),
    );
    expect(checkedSlots()).toHaveLength(0);
    expect(submitButton()).toBeDisabled();
  });

  it('allows ordering without a window when the zone makes it optional', async () => {
    routes['POST /checkout/quote'] = () => respond(chekkaQuote({ slot_required: false }));
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    expect(slotGroup()).not.toHaveAttribute('aria-required');
    expect(submitButton()).toBeEnabled();

    pickSlot(SLOT.tomorrow);
    fireEvent.click(screen.getByTestId('slot-clear'));
    expect(checkedSlots()).toHaveLength(0);
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0)).not.toHaveProperty('delivery_slot_id');
  });

  it('keeps the order blocked and explains it when every window is full', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(
        chekkaQuote({
          delivery_slots: [slotOption({ id: SLOT.tomorrow, is_full: true, remaining: 0 })],
        }),
      );
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    expect(screen.getByTestId('slots-none')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('works in Russian', async () => {
    renderCheckout('ru');
    await screen.findByLabelText('Район');
    fireEvent.change(screen.getByLabelText('Район'), { target: { value: 'chilonzor' } });
    await screen.findByRole('radiogroup', { name: 'Время доставки' });
    expect(screen.getByRole('tab', { name: /Завтра, 01\.11/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Сегодня, 31.10, 10:00–12:00' })).toBeInTheDocument();
    expect(screen.getByTestId('submit-reason')).toHaveTextContent(
      'Выберите время доставки, чтобы оформить заказ.',
    );
  });
});

describe('CheckoutView in the Telegram Mini App: delivery slots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T05:00:00Z'));
    routes['GET /delivery/zones'] = () =>
      respond({ items: [zone(), chekkaZone()], timezone: 'Asia/Tashkent' });
    routes['POST /checkout/quote'] = (init) => {
      const { district } = JSON.parse(String(init.body)) as { district: DistrictCode };
      return respond(district === 'yunusobod' ? quote() : chekkaQuote());
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the MainButton disabled, with an inline reason, until a window is chosen', async () => {
    const { webApp, state } = trackedWebApp();
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();

    await waitFor(() => expect(screen.getByTestId('slot-reason')).toBeInTheDocument());
    expect(screen.getByTestId('slot-reason')).toHaveTextContent(
      'Buyurtma berish uchun yetkazish vaqtini tanlang.',
    );
    expect(screen.queryByTestId('submit-bar')).toBeNull();
    expect(state.disabled).toBe(true);
    act(() => pressMainButton(webApp));
    expect(orderPosts()).toHaveLength(0);

    pickSlot(SLOT.later);
    await waitFor(() => expect(state.disabled).toBe(false));
    expect(screen.queryByTestId('slot-reason')).toBeNull();
    expect(state.text).toBe(`Buyurtma berish — 120${NB}000${NB}so‘m`);

    act(() => pressMainButton(webApp));
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(bodyOf(0).delivery_slot_id).toBe(SLOT.later);
  });

  it('disables the MainButton again after the server refuses the window', async () => {
    const { webApp, state } = trackedWebApp();
    routes['POST /orders'] = () => apiError('slot_full', 409);
    renderCheckout();
    await loaded();
    await fillValidForSlotZone();
    pickSlot(SLOT.tomorrow);
    await waitFor(() => expect(state.disabled).toBe(false));
    act(() => pressMainButton(webApp));

    await screen.findByTestId('slot-notice');
    await waitFor(() => expect(state.disabled).toBe(true));
    expect(webApp.HapticFeedback?.notificationOccurred).toHaveBeenCalledWith('error');
  });
});

/** One second of the rate-limit countdown (the next timer is only set after React re-renders). */
async function tick(seconds = 1) {
  for (let index = 0; index < seconds; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

/** Advances the fake clock a second at a time until `done()` (bounded). */
async function tickUntil(done: () => boolean, max = 15) {
  for (let second = 0; second < max && !done(); second += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

const quoteError = () => screen.getByTestId('quote-error');
const retryInside = (element: HTMLElement) =>
  within(element).getByRole('button', { name: 'Qayta urinish' });

describe('CheckoutView: a rate-limited order (429)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the wait once, counts it down on the button only, then retries with the SAME key', async () => {
    let limited = true;
    routes['POST /orders'] = () =>
      limited ? apiError('rate_limited', 429, {}, { 'Retry-After': '3' }) : respond(order(), 201);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());

    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveAttribute('data-failure', 'rate_limited');
    expect(failure).toHaveTextContent('Juda ko‘p urinish. 3 soniyadan keyin qayta urinib ko‘ring.');
    const retry = retryInside(failure);
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent('(3 s)');
    expect(submitButton()).toBeDisabled();
    // The countdown is visible but not part of the accessible name (a live region would read it
    // out every second).
    expect(retry).toHaveAccessibleName('Qayta urinish');

    // Advance in small steps: the next one-second timer exists only after React re-rendered, so
    // one 1000 ms jump can land before it is armed.
    for (let step = 0; step < 30 && !retry.textContent?.includes('(2 s)'); step += 1) {
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(retry).toHaveTextContent('(2 s)');
    expect(failure).toHaveTextContent('3 soniyadan'); // the sentence does not tick
    await tickUntil(() => !(retry as HTMLButtonElement).disabled);
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveTextContent('(');
    expect(submitButton()).toBeEnabled();
    expect(orderPosts()).toHaveLength(1); // nothing was sent while waiting

    limited = false;
    fireEvent.click(retry);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
    expect(orderPosts()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  it('does not send anything while waiting, however the submit is triggered', async () => {
    routes['POST /orders'] = () => apiError('rate_limited', 429, {}, { 'Retry-After': '5' });
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await screen.findByTestId('submit-failure');

    // An implicit submission (Enter in a field) reaches the handler even with the button disabled.
    fireEvent.submit(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }));
    await tick();
    fireEvent.submit(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }));
    expect(orderPosts()).toHaveLength(1);
  });

  it('falls back to 10 s without Retry-After, and caps an absurd one at 120 s', async () => {
    routes['POST /orders'] = () => apiError('rate_limited', 429);
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    expect(await screen.findByTestId('submit-failure')).toHaveTextContent('10 soniyadan');

    await tickUntil(
      () =>
        !within(screen.getByTestId('submit-failure')).getByRole('button').hasAttribute('disabled'),
    );
    routes['POST /orders'] = () => apiError('rate_limited', 429, {}, { 'Retry-After': '86400' });
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(2));
    expect(await screen.findByTestId('submit-failure')).toHaveTextContent('120 soniyadan');
  });

  it('speaks Russian', async () => {
    routes['POST /orders'] = () => apiError('rate_limited', 429, {}, { 'Retry-After': '4' });
    renderCheckout('ru');
    await screen.findByLabelText('Район');
    fireEvent.change(screen.getByLabelText('Район'), { target: { value: 'yunusobod' } });
    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).not.toBe('—'));
    fireEvent.change(screen.getByLabelText('Улица'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByLabelText('Дом'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Номер телефона'), {
      target: { value: '+998 00 123-45-67' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Наличными при получении' }));
    fireEvent.click(submitButton());
    const failure = await screen.findByTestId('submit-failure');
    expect(failure).toHaveTextContent('Слишком много попыток. Повторите через 4 сек.');
    expect(within(failure).getByRole('button', { name: 'Повторить' })).toHaveTextContent('(4 с)');
  });
});

describe('CheckoutView: a quote that could not be fetched', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pickDistrictWithoutQuote() {
    fireEvent.change(screen.getByLabelText('Tuman'), { target: { value: 'yunusobod' } });
    await screen.findByTestId('quote-error');
  }

  function fillRest() {
    type('Ko‘cha', 'Demo ko‘cha');
    type('Uy', '12');
    type('Telefon raqami', '+998 00 123-45-67');
    fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
  }

  it('offers a retry next to the message (there was none: Telegram had no way out at all)', async () => {
    let failing = true;
    routes['POST /checkout/quote'] = () => {
      if (failing) throw ApiRequestError.network();
      return respond(quote());
    };
    renderCheckout();
    await loaded();
    await pickDistrictWithoutQuote();
    expect(quoteError()).toHaveAttribute('data-failure', 'network');
    expect(quoteError()).toHaveTextContent('Narxni hisoblab bo‘lmadi.');

    failing = false;
    fireEvent.click(retryInside(quoteError()));
    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).not.toBe('—'));
    expect(screen.queryByTestId('quote-error')).toBeNull();
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
  });

  it('moves the customer to the message when a tap on "order" had to re-quote and could not', async () => {
    routes['POST /checkout/quote'] = () => {
      throw ApiRequestError.network();
    };
    renderCheckout();
    await loaded();
    await pickDistrictWithoutQuote();
    fillRest();
    fireEvent.click(submitButton());
    await waitFor(() => expect(quoteError()).toHaveFocus());
    expect(orderPosts()).toHaveLength(0);
    // Retrying from there works, and the order can then be placed.
    routes['POST /checkout/quote'] = () => respond(quote());
    fireEvent.click(retryInside(quoteError()));
    await waitFor(() => expect(screen.queryByTestId('quote-error')).toBeNull());
    fireEvent.click(submitButton());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledOnce());
  });

  it('waits out a 429 on the quote too: no request from the retry or the submit control meanwhile', async () => {
    let limited = true;
    routes['POST /checkout/quote'] = () =>
      limited ? apiError('rate_limited', 429, {}, { 'Retry-After': '2' }) : respond(quote());
    renderCheckout();
    await loaded();
    await pickDistrictWithoutQuote();
    expect(quoteError()).toHaveAttribute('data-failure', 'rate_limited');
    expect(quoteError()).toHaveTextContent(
      'Juda ko‘p urinish. 2 soniyadan keyin qayta urinib ko‘ring.',
    );
    const retry = retryInside(quoteError());
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent('(2 s)');
    expect(submitButton()).toBeDisabled();
    fireEvent.click(retry);
    fillRest();
    fireEvent.submit(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }));
    expect(calls('POST', '/checkout/quote')).toHaveLength(1);

    await tickUntil(() => !(retry as HTMLButtonElement).disabled);
    expect(retry).toBeEnabled();
    limited = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('checkout-total').textContent).not.toBe('—'));
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
    expect(submitButton()).toBeEnabled();
  });

  it('keeps the district error without a retry (retrying would not help)', async () => {
    routes['POST /checkout/quote'] = () => apiError('district_not_served', 422);
    renderCheckout();
    await loaded();
    await pickDistrictWithoutQuote();
    expect(quoteError()).toHaveAttribute('data-failure', 'district_not_served');
    expect(within(quoteError()).queryByRole('button')).toBeNull();
  });

  it('gives the Telegram MainButton a way out: it stays disabled, the retry brings it back', async () => {
    const { state } = trackedWebApp();
    let failing = true;
    routes['POST /checkout/quote'] = () => {
      if (failing) throw ApiRequestError.network();
      return respond(quote());
    };
    renderCheckout();
    await loaded();
    await pickDistrictWithoutQuote();
    fillRest();
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.disabled).toBe(true);

    failing = false;
    fireEvent.click(retryInside(quoteError()));
    await waitFor(() => expect(state.disabled).toBe(false));
  });
});
