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
  zone,
} from '@/lib/checkout/test-fixtures';
import { isValidIdempotencyKey } from '@/lib/checkout/idempotency';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import type { TelegramWebApp } from '@/lib/telegram/types';
import { CheckoutView } from './checkout-view';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace }) }));

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { first_name: 'Ali', last_name: 'Valiyev' } as {
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
  session.user = { first_name: 'Ali', last_name: 'Valiyev' };
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
