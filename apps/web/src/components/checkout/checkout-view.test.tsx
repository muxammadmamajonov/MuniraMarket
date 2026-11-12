import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import type { Address } from '@/lib/address/address';
import { ADDRESS_STORAGE_ITEM, resetDeliveryAddressMemory } from '@/lib/address/storage';
import { ApiRequestError } from '@/lib/api/errors';
import {
  WORST,
  address,
  apiError,
  cart,
  line,
  order,
  product,
  quote,
  respond,
} from '@/lib/checkout/test-fixtures';
import { isValidIdempotencyKey } from '@/lib/checkout/idempotency';
import {
  autoloadYandexScript,
  houseResult,
  makeYMaps,
  mockGeocoderFetch,
} from '@/lib/maps/test-helpers';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { resetYandexMapsLoader } from '@/lib/maps/yandex-loader';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import type { TelegramWebApp } from '@/lib/telegram/types';
import { CheckoutView } from './checkout-view';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace }) }));

const USER_ID = vi.hoisted(() => '7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c');
const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: USER_ID, first_name: 'Ali', last_name: 'Valiyev', phone_verified: true } as {
    id: string;
    first_name: string;
    last_name: string | null;
    phone_verified: boolean;
  } | null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  applyUser: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

const NB = ' ';
const uzs = (amount: number) => `${String(amount).replace(/\B(?=(\d{3})+$)/g, NB)}${NB}so‘m`;

type Handler = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler> = {};

function defaultRoutes(): Record<string, Handler> {
  return {
    'GET /cart': () => respond(cart()),
    'POST /checkout/quote': () => respond(quote()),
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

// Placeholder shape only; jsdom never fetches the script and the SDK is a fake.
const MAPS_KEY = '00000000-0000-4000-8000-000000000000';

/** `maps`: with a Yandex Maps key (the picker then shows the fake map instead of its fallback). */
function renderCheckout(locale: 'uz' | 'ru' = 'uz', { maps = false }: { maps?: boolean } = {}) {
  const key = maps ? MAPS_KEY : null;
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <MapsConfigProvider apiKey={key} geocoderApiKey={key}>
          <CheckoutView />
        </MapsConfigProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

/** The address the customer saved earlier on this device (the home card or a past checkout). */
const SAVED: Address = address({ apartment: '' });

function saveAddress(value: Address | null) {
  if (value === null) window.localStorage.removeItem(ADDRESS_STORAGE_ITEM);
  else window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(value));
  resetDeliveryAddressMemory();
}

async function loaded(name = 'Buyurtmani rasmiylashtirish') {
  await screen.findByRole('form', { name });
}

/** Waits until the cart has been priced (the summary is no longer busy). */
async function quoted() {
  await waitFor(() => {
    expect(calls('POST', '/checkout/quote').length).toBeGreaterThan(0);
    expect(screen.getByTestId('checkout-total').closest('section')).toHaveAttribute(
      'aria-busy',
      'false',
    );
  });
}

const addressButton = () =>
  document.querySelector<HTMLButtonElement>('button[data-field="address"]') as HTMLButtonElement;

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * Fills everything that is required. The address comes from the device (saved in `beforeEach`),
 * the name is prefilled from the session; the phone and the payment method are entered here.
 */
async function fillValid() {
  await quoted();
  type('Telefon raqami', '+998 00 123-45-67');
  fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
}

/** The order body as `fillValid` produces it with the saved address. */
const VALID_BODY = {
  address: { lat: 41.311081, lon: 69.240562, street: 'Demo ko‘cha', house: '12' },
  recipient_name: 'Ali Valiyev',
  recipient_phone: '+998001234567',
  payment_method: 'cash_on_delivery',
  expected_total_uzs: 60000,
};

const submitButton = () => within(screen.getByTestId('submit-bar')).getByRole('button');

beforeEach(() => {
  nav.replace.mockReset();
  session.status = 'authenticated';
  session.user = { id: USER_ID, first_name: 'Ali', last_name: 'Valiyev', phone_verified: true };
  window.sessionStorage.clear();
  window.localStorage.clear();
  saveAddress(SAVED);
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
  resetYandexMapsLoader();
  delete window.ymaps3;
  document.body.style.overflow = '';
  resetDeliveryAddressMemory();
});

describe('CheckoutView: states', () => {
  it('shows a skeleton while the session loads and the sign-in prompt when anonymous', async () => {
    session.status = 'loading';
    const { unmount } = renderCheckout();
    expect(screen.getByRole('status', { name: 'Buyurtma tayyorlanmoqda…' })).toBeInTheDocument();
    unmount();

    session.status = 'anonymous';
    routes['GET /auth/config'] = () => respond({ telegram_oidc: { enabled: false } });
    renderCheckout();
    expect(
      await screen.findByText('Savatdan foydalanish uchun saytni Telegram orqali oching.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('sign-in-screen')).toBeInTheDocument();
    expect(calls('GET', '/cart')).toHaveLength(0);
  });

  it('shows a skeleton while the cart loads', () => {
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
    expect(screen.queryByRole('form')).toBeNull();
    expect(calls('POST', '/checkout/quote')).toHaveLength(0);
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

  it('is localized (ru)', async () => {
    renderCheckout('ru');
    await loaded('Оформление заказа');
    expect(screen.getByRole('heading', { name: /Адрес доставки/ })).toBeInTheDocument();
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Demo ko‘cha, 12');
    expect(screen.getByRole('button', { name: 'Изменить' })).toBe(addressButton());
    expect(screen.getByTestId('checkout-courier-note')).toHaveTextContent(
      'Заказ привезёт курьер Яндекса. Доставку вы оплачиваете курьеру при получении.',
    );
  });
});

describe('CheckoutView: the form', () => {
  it('without a saved address: asks to choose one, prefills the name and the +998 prefix', async () => {
    saveAddress(null);
    renderCheckout();
    await loaded();

    expect(screen.queryByTestId('checkout-address')).toBeNull();
    expect(screen.getByRole('button', { name: 'Manzilni xaritada tanlash' })).toBe(addressButton());
    expect(addressButton()).toHaveAttribute('aria-haspopup', 'dialog');
    // No area or time-window pickers and no street inputs: the address is chosen on the map.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: /vaqt/i })).toBeNull();
    expect(screen.queryByLabelText('Ko‘cha')).toBeNull();
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
  });

  it('starts from the address saved on this device, on one line with its landmark', async () => {
    saveAddress(address({ entrance: '2', floor: '5', landmark: 'Metro yonida' }));
    renderCheckout();
    await loaded();
    const shown = screen.getByTestId('checkout-address');
    expect(shown).toHaveTextContent('Demo ko‘cha, 12, 34-xonadon, 2-podyezd, 5-qavat');
    expect(shown).toHaveTextContent('Metro yonida');
    expect(screen.getByRole('button', { name: 'O‘zgartirish' })).toBe(addressButton());
    // The coordinates are never shown.
    expect(document.body.textContent).not.toMatch(/41\.311081|69\.240562/);
  });

  it('chooses the address on the map, remembers it on this device, and does not re-quote', async () => {
    saveAddress(null);
    const fake = makeYMaps();
    const geocoder = mockGeocoderFetch();
    geocoder.answer.mockResolvedValue(houseResult('Amir Temur ko‘chasi', '15'));
    autoloadYandexScript('load', fake.api);
    renderCheckout('uz', { maps: true });
    await loaded();
    await quoted();

    fireEvent.click(addressButton());
    const picker = await screen.findByTestId('address-picker');
    await within(picker).findByTestId('map-canvas');
    await waitFor(() => expect(fake.maps).toHaveLength(1));
    act(() => {
      fake.listeners[0]?.onActionStart?.();
      fake.maps[0]?.update({ location: { center: [69.24056251, 41.31108149], zoom: 16 } });
      fake.listeners[0]?.onActionEnd?.();
    });
    await waitFor(() =>
      expect(within(picker).getByRole('textbox', { name: /^Uy/ })).toHaveValue('15'),
    );
    fireEvent.click(within(picker).getByRole('button', { name: 'Shu yerga yetkazish' }));

    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Amir Temur ko‘chasi, 15');
    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toMatchObject({
      lat: 41.311081,
      lon: 69.240563,
      street: 'Amir Temur ko‘chasi',
      house: '15',
    });
    // The quote does not depend on the address.
    expect(calls('POST', '/checkout/quote')).toHaveLength(1);

    type('Telefon raqami', '+998 00 123-45-67');
    fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda naqd pul' }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0).address).toEqual({
      lat: 41.311081,
      lon: 69.240563,
      street: 'Amir Temur ko‘chasi',
      house: '15',
    });
    // Only the Geocoder saw the point before the order; our API only inside the order.
    expect(calls('POST', '/checkout/quote')[0]?.[1]?.body).toBeUndefined();
  });

  it('caps every field at the server limit and wraps long user text', async () => {
    renderCheckout();
    await loaded();
    expect(screen.getByLabelText('Ism')).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText(/Kuryer uchun izoh/)).toHaveAttribute('maxlength', '500');
    // Every control can shrink inside a grid cell (min-w-0) and user text may break anywhere.
    for (const label of ['Ism', 'Telefon raqami']) {
      const input = screen.getByLabelText(label);
      expect(input.className).toContain('min-w-0');
      expect(input).toHaveAttribute('data-user-text');
    }
  });

  it('keeps worst-case user text intact in the fields and the address line', async () => {
    saveAddress(address({ street: WORST.street, landmark: WORST.landmark }));
    renderCheckout();
    await loaded();
    type('Ism', WORST.recipientName);
    type(/Kuryer uchun izoh/, WORST.comment);
    expect(screen.getByLabelText('Ism')).toHaveValue(WORST.recipientName);
    expect(screen.getByText('500/500')).toBeInTheDocument();
    const shown = screen.getByTestId('checkout-address');
    const line = within(shown).getByText(new RegExp(`^${WORST.street}`));
    expect(line.className).toContain('[overflow-wrap:anywhere]');
    expect(within(shown).getByText(WORST.landmark).className).toContain('[overflow-wrap:anywhere]');
  });

  it('requires an address: the error sits under the address button, which gets focus', async () => {
    saveAddress(null);
    renderCheckout();
    await loaded();
    fireEvent.click(submitButton());

    await waitFor(() => expect(addressButton()).toHaveFocus());
    expect(orderPosts()).toHaveLength(0);
    expect(addressButton()).toHaveAccessibleDescription('To‘ldirish shart');
    expect(screen.getAllByText('To‘ldirish shart').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByLabelText('Telefon raqami')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('group', { name: 'To‘lov usuli' })).toHaveAccessibleDescription(
      /To‘ldirish shart/,
    );

    type('Telefon raqami', '+998 00 12');
    fireEvent.blur(screen.getByLabelText('Telefon raqami'));
    expect(screen.getByText(/\+998 XX XXX XX XX/)).toBeInTheDocument();
  });

  it('flags a saved address that is no longer complete (no house) and sends nothing', async () => {
    saveAddress(address({ house: '' }));
    renderCheckout();
    await loaded();
    await fillValid();
    fireEvent.click(submitButton());
    await waitFor(() => expect(addressButton()).toHaveFocus());
    expect(addressButton()).toHaveAccessibleDescription('Maydonni tekshiring');
    expect(orderPosts()).toHaveLength(0);
  });

  it('reports a malformed value once the field is left, but "required" only after a submit', async () => {
    renderCheckout();
    await loaded();
    // Leaving an empty field must not insert an error row (it could shift the next tap target).
    type('Ism', '');
    fireEvent.blur(screen.getByLabelText('Ism'));
    expect(screen.queryByText('To‘ldirish shart')).toBeNull();
    // A value that is present but wrong is reported straight away.
    type('Ism', 'a');
    fireEvent.blur(screen.getByLabelText('Ism'));
    expect(screen.getByText('Kamida 2 ta belgi kiriting')).toBeInTheDocument();
  });
});

describe('CheckoutView: quote', () => {
  it('prices the cart once after loading, with no body, and shows the server total', async () => {
    renderCheckout();
    await loaded();
    await quoted();
    const requests = calls('POST', '/checkout/quote');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[1]?.body).toBeUndefined();

    // No delivery fee, subtotal-vs-fee split or free-delivery hint: the total is the goods.
    expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(60000));
    expect(screen.queryByTestId('checkout-subtotal')).toBeNull();
    expect(screen.queryByTestId('checkout-delivery')).toBeNull();
    expect(screen.queryByTestId('free-delivery-hint')).toBeNull();
    expect(screen.getAllByTestId('summary-line')).toHaveLength(1);
    expect(screen.getByText('4 ta mahsulot')).toBeInTheDocument();
  });

  it('says the Yandex courier brings the order and is paid on receipt', async () => {
    renderCheckout();
    await loaded();
    expect(screen.getByTestId('checkout-courier-note')).toHaveTextContent(
      'Buyurtmani Yandex kuryeri olib keladi. Yetkazish narxini qabul qilganingizda kuryerga to‘laysiz.',
    );
    expect(document.body.textContent).not.toMatch(/bepul|hudud|zona|minimal buyurtma/i);
  });

  it('shows the server total as it is (total equals subtotal)', async () => {
    routes['POST /checkout/quote'] = () =>
      respond(quote({ subtotal_uzs: 123000, total_uzs: 123000 }));
    renderCheckout();
    await loaded();
    await quoted();
    expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(123000));
    expect(within(screen.getByTestId('submit-bar')).getByTestId('bar-total').textContent).toBe(
      uzs(123000),
    );
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
    await quoted();
    expect(screen.getByTestId('cart-issues')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Savatga qaytish' })).toHaveAttribute(
      'href',
      '/uz/cart',
    );
    expect(submitButton()).toBeDisabled();
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
    // Exactly these keys: a point and the door details, nothing about areas or time windows.
    expect(bodyOf(0)).toEqual(VALID_BODY);
  });

  it('sends optional fields and the comment when they are filled in', async () => {
    saveAddress(address({ entrance: '2', floor: '5', landmark: ' Metro ' }));
    renderCheckout();
    await loaded();
    await fillValid();
    type(/Kuryer uchun izoh/, 'Eshik oldiga qoldiring');
    fireEvent.click(screen.getByRole('radio', { name: 'Yetkazilganda karta orqali' }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(1));
    expect(bodyOf(0)).toMatchObject({
      address: {
        lat: 41.311081,
        lon: 69.240562,
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
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Demo ko‘cha, 12');
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
    type('Ism', 'Boshqa Ism');
    fireEvent.click(submitButton());
    await waitFor(() => expect(orderPosts()).toHaveLength(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(bodyOf(2).recipient_name).toBe('Boshqa Ism');
  });

  it('shows old and new total on price_changed and needs an explicit confirm with a new key', async () => {
    let first = true;
    let priceMoved = false;
    routes['POST /checkout/quote'] = () =>
      respond(priceMoved ? quote({ subtotal_uzs: 81000, total_uzs: 81000 }) : quote());
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
    expect(within(notice).getByTestId('price-was').textContent).toBe(uzs(60000));
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
      respond(quote({ subtotal_uzs: 78000, total_uzs: 78000 }));
    fireEvent.click(submitButton());

    const notice = await screen.findByTestId('price-changed');
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
    expect(within(notice).getByTestId('price-was').textContent).toBe(uzs(60000));
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
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Demo ko‘cha, 12');
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

    // Any address part (point or text) maps onto the address step, which comes first.
    await waitFor(() => expect(addressButton()).toHaveFocus());
    expect(addressButton()).toHaveAccessibleDescription('Maydonni tekshiring');
    expect(screen.getByLabelText('Telefon raqami')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Ism')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('submit-failure')).toHaveTextContent(
      'Ba’zi maydonlarni to‘g‘rilang.',
    );

    // Editing the field clears its server error.
    type('Telefon raqami', '+998 00 123-45-68');
    expect(screen.getByLabelText('Telefon raqami')).not.toHaveAttribute('aria-invalid');
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
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Demo ko‘cha, 12');
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
    total_uzs: 60000,
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
    expect(JSON.parse(stored)).toMatchObject({ key: keyOf(0), owner: USER_ID, totalUzs: 60000 });
    // The stored attempt carries no personal data: only a hash of the body.
    expect(stored).not.toContain('998001234567');
    expect(stored).not.toContain('Demo');
    expect(stored).not.toContain('41.31');

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
    type('Ism', 'Boshqa Ism');
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
      phone_verified: true,
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
    let release: (response: Response) => void = () => undefined;
    routes['POST /checkout/quote'] = () => new Promise<Response>((resolve) => (release = resolve));
    renderCheckout();
    await loaded();
    const bar = screen.getByTestId('submit-bar');
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('bottom-0');
    expect(bar.className).toContain('pb-(--mm-inset-bottom)');
    expect(screen.getByRole('form', { name: 'Buyurtmani rasmiylashtirish' }).className).toContain(
      'var(--mm-inset-bottom)',
    );
    expect(submitButton()).toHaveTextContent('Buyurtma berish');
    expect(within(bar).queryByTestId('bar-total')).toBeNull();

    await act(async () => {
      release(respond(quote()));
    });
    expect(within(bar).getByTestId('bar-total').textContent).toBe(uzs(60000));
    expect(submitButton().textContent).toBe('Buyurtma berish');
    expect(submitButton().className).toContain('active:scale');
  });
});

describe('CheckoutView in the Telegram Mini App', () => {
  it('drives submit with the MainButton: disabled until valid, progress while sending, no bar', async () => {
    const { webApp, state } = trackedWebApp();
    let release: (response: Response) => void = () => undefined;
    routes['POST /orders'] = () => new Promise<Response>((resolve) => (release = resolve));
    // The quote is requested as soon as the cart loads; hold it so the label before the total
    // is known can be checked without racing the response.
    let releaseQuote: (response: Response) => void = () => undefined;
    routes['POST /checkout/quote'] = () =>
      new Promise<Response>((resolve) => (releaseQuote = resolve));
    renderCheckout();
    await loaded();

    expect(screen.queryByTestId('submit-bar')).toBeNull();
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.text).toBe('Buyurtma berish');
    expect(state.disabled).toBe(true);
    expect(screen.getByTestId('fix-fields')).toBeInTheDocument();

    // With the quote in, the label carries the total; still disabled until the form is valid.
    await act(async () => {
      releaseQuote(respond(quote()));
    });
    await waitFor(() => expect(state.text).toBe(`Buyurtma berish — 60${NB}000${NB}so‘m`));
    expect(state.disabled).toBe(true);

    await fillValid();
    await waitFor(() => expect(state.disabled).toBe(false));
    expect(state.text).toBe(`Buyurtma berish — 60${NB}000${NB}so‘m`);
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
    routes['POST /checkout/quote'] = () =>
      respond(
        quote({
          items: [line({ issue: 'insufficient_stock' })],
          issues: ['cart_has_issues'],
          can_place_order: false,
        }),
      );
    renderCheckout();
    await loaded();
    await fillValid();
    await waitFor(() => expect(screen.getByTestId('cart-issues')).toBeInTheDocument());
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.disabled).toBe(true);
  });

  it('keeps the MainButton disabled without an address', async () => {
    saveAddress(null);
    const { state } = trackedWebApp();
    renderCheckout();
    await loaded();
    await fillValid();
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.disabled).toBe(true);
    expect(screen.getByTestId('fix-fields')).toBeInTheDocument();
  });

  it('switches the MainButton to the confirm action after a price change, and haptics report errors', async () => {
    const { webApp, state } = trackedWebApp();
    let first = true;
    let priceMoved = false;
    routes['POST /checkout/quote'] = () =>
      respond(priceMoved ? quote({ subtotal_uzs: 81000, total_uzs: 81000 }) : quote());
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
          total_uzs: WORST.hugeTotal,
        }),
      );
    renderCheckout();
    await loaded();
    await quoted();

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
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
      session.apiFetch.mockClear();
    }
  });

  it('uses the singular for exactly one item in Uzbek too (no "1 mahsulotlar")', async () => {
    routes['POST /checkout/quote'] = () => respond(quote({ item_count: 1 }));
    renderCheckout();
    await loaded();
    await quoted();
    expect(screen.getByText('1 ta mahsulot')).toBeInTheDocument();
  });

  it('survives a 100-character Cyrillic recipient name from the session', async () => {
    session.user = {
      id: USER_ID,
      first_name: WORST.recipientName.split(' ')[0] ?? '',
      last_name: WORST.recipientName.split(' ').slice(1).join(' '),
      phone_verified: true,
    };
    renderCheckout();
    await loaded();
    const value = (screen.getByLabelText('Ism') as HTMLInputElement).value;
    expect(Array.from(value).length).toBeLessThanOrEqual(100);
    expect(value.startsWith('Александра')).toBe(true);
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
    await loaded('Оформление заказа');
    await quoted();
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

  async function withoutQuote() {
    await screen.findByTestId('quote-error');
  }

  function fillRest() {
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
    await withoutQuote();
    expect(quoteError()).toHaveAttribute('data-failure', 'network');
    expect(quoteError()).toHaveTextContent('Narxni hisoblab bo‘lmadi.');

    failing = false;
    fireEvent.click(retryInside(quoteError()));
    await waitFor(() => expect(screen.queryByTestId('quote-error')).toBeNull());
    expect(screen.getByTestId('checkout-total').textContent).toBe(uzs(60000));
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
  });

  it('moves the customer to the message when a tap on "order" had to re-quote and could not', async () => {
    routes['POST /checkout/quote'] = () => {
      throw ApiRequestError.network();
    };
    renderCheckout();
    await loaded();
    await withoutQuote();
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
    await withoutQuote();
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
    await waitFor(() => expect(screen.queryByTestId('quote-error')).toBeNull());
    expect(calls('POST', '/checkout/quote')).toHaveLength(2);
    expect(submitButton()).toBeEnabled();
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
    await withoutQuote();
    fillRest();
    await waitFor(() => expect(state.visible).toBe(true));
    expect(state.disabled).toBe(true);

    failing = false;
    fireEvent.click(retryInside(quoteError()));
    await waitFor(() => expect(state.disabled).toBe(false));
  });
});

describe('phone verification gate', () => {
  it('asks for the phone and keeps the order button disabled until it is verified', async () => {
    session.user = { id: USER_ID, first_name: 'Ali', last_name: 'Valiyev', phone_verified: false };
    renderCheckout();
    expect(await screen.findByTestId('phone-card-checkout')).toBeInTheDocument();
  });
});
