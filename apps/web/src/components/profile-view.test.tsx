import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { POLL_ATTEMPTS, POLL_INTERVAL_MS } from './phone-card';
import { ProfileView, initialOf } from './profile-view';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/uz/profile',
  useRouter: () => ({ replace: nav.replace }),
}));

interface TestUser {
  first_name: string;
  last_name: string | null;
  username?: string | null;
  language?: 'uz' | 'ru';
  phone_verified?: boolean;
  phone_hint?: string | null;
}

const session = vi.hoisted(() => ({
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null as null | TestUser,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  refresh: vi.fn<() => Promise<TestUser | null>>(),
  applyUser: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderProfile(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <ProfileView />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'anonymous';
  session.user = null;
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json({ telegram_oidc: { enabled: false } }));
  session.refresh.mockReset();
  session.applyUser.mockReset();
  nav.replace.mockReset();
  document.cookie = 'locale=; Max-Age=0; Path=/';
});

afterEach(() => {
  uninstallWebApp();
  vi.useRealTimers();
});

describe('initialOf', () => {
  it('takes the first whole character', () => {
    expect(initialOf('aleksandra')).toBe('A');
    expect(initialOf('  Jo')).toBe('J');
    expect(initialOf('Ölmez')).toBe('Ö');
    expect(initialOf('👩‍🚀 Kosmonavt')).toBe('👩‍🚀');
    expect(initialOf('')).toBe('');
  });
});

describe('ProfileView', () => {
  it('while the session is checked, shows a status placeholder', () => {
    session.status = 'loading';
    renderProfile();
    expect(screen.getByRole('status', { name: 'Tekshirilmoqda…' })).toBeInTheDocument();
  });

  it('anonymous: the branded sign-in screen, language kept in the browser, help', async () => {
    renderProfile();
    expect(screen.getByTestId('sign-in-screen')).toHaveTextContent('Telegram orqali kiring');
    expect(
      await screen.findByText('Savatdan foydalanish uchun saytni Telegram orqali oching.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(session.apiFetch).not.toHaveBeenCalledWith('/me/language', expect.anything());
    expect(document.cookie).toContain('locale=ru');
    expect(nav.replace).toHaveBeenCalledWith('/ru/profile');
    expect(screen.getByRole('link', { name: /Yordam/ })).toHaveAttribute('href', '/uz/help');
    expect(screen.queryByRole('button', { name: 'Chiqish' })).toBeNull();
  });

  it('authenticated (browser): account, phone status, orders, language and sign out', () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: 'Karimova', username: 'munira' };
    renderProfile();
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Munira Karimova');
    expect(screen.getByText('@munira')).toBeInTheDocument();
    expect(screen.getByTestId('phone-card-profile')).toHaveTextContent('Telefon raqami');
    // No bot link configured and not in Telegram: say where to verify, no fake button.
    expect(screen.getByTestId('phone-card-profile')).toHaveTextContent(
      'Raqamni tasdiqlash uchun do‘konni Telegram’da oching.',
    );
    expect(screen.getByRole('link', { name: /Buyurtmalarim/ })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    screen.getByRole('button', { name: 'Chiqish' }).click();
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it('shows the masked verified number with an update action in the Mini App', () => {
    installWebApp(makeWebApp());
    session.status = 'authenticated';
    session.user = {
      first_name: 'Munira',
      last_name: null,
      phone_verified: true,
      phone_hint: '+998 •• ••• 45 67',
    };
    renderProfile('ru');
    const card = screen.getByTestId('phone-card-profile');
    expect(card).toHaveTextContent('+998 •• ••• 45 67');
    expect(card).toHaveTextContent('Подтверждён');
    expect(screen.getByRole('button', { name: 'Обновить номер' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull();
  });

  it('shares the phone through Telegram and waits for the bot to verify it', async () => {
    vi.useFakeTimers();
    const requestContact = vi.fn((callback?: (shared: boolean) => void) => callback?.(true));
    installWebApp(makeWebApp({ requestContact, isVersionAtLeast: () => true }));
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null, phone_verified: false };
    session.refresh
      .mockResolvedValueOnce({ first_name: 'Munira', last_name: null, phone_verified: false })
      .mockResolvedValueOnce({ first_name: 'Munira', last_name: null, phone_verified: true });
    renderProfile();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Raqamni Telegram orqali ulashish' }));
    });
    expect(requestContact).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
      'Telegram’dan tasdiq kutilmoqda…',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(session.refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Raqamingiz tasdiqlandi.')).toBeInTheDocument();
  });

  it('says so when the user declines, and times out honestly', async () => {
    vi.useFakeTimers();
    let answer = false;
    const requestContact = vi.fn((callback?: (shared: boolean) => void) => callback?.(answer));
    installWebApp(makeWebApp({ requestContact, isVersionAtLeast: () => true }));
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null, phone_verified: false };
    session.refresh.mockResolvedValue({ first_name: 'Munira', last_name: null });
    renderProfile();
    const share = screen.getByRole('button', { name: 'Raqamni Telegram orqali ulashish' });
    await act(async () => {
      fireEvent.click(share);
    });
    expect(screen.getByText(/Raqam ulashilmadi/)).toBeInTheDocument();

    answer = true;
    await act(async () => {
      fireEvent.click(share);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * POLL_ATTEMPTS + 10);
    });
    expect(screen.getByText(/Tasdiq hali kelmadi/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Qayta tekshirish' })).toBeInTheDocument();
  });

  it('saves the language to the account, then the URL follows', async () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null };
    const saved = { first_name: 'Munira', last_name: null, language: 'ru' as const };
    session.apiFetch.mockResolvedValue(Response.json({ user: saved }));
    renderProfile();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/ru/profile'));
    expect(session.apiFetch).toHaveBeenCalledWith(
      '/me/language',
      expect.objectContaining({ method: 'PUT', body: '{"language":"ru"}' }),
    );
    expect(session.applyUser).toHaveBeenCalledWith(saved);
  });

  it('keeps the page and explains when the language could not be saved', async () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null };
    session.apiFetch.mockResolvedValue(new Response(null, { status: 503 }));
    renderProfile();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tilni saqlab bo‘lmadi');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a very long name wraps (clamped to two lines) instead of widening the page', () => {
    session.status = 'authenticated';
    session.user = {
      first_name: 'Aleksandra-Wiśniewska-Kowalczyk-Abdurakhmonova-Nurmukhammedova',
      last_name: 'Bartholomew-Fitzgerald-Northwind-Industries-Holdings',
    };
    renderProfile();
    const name = screen.getByTestId('profile-name');
    expect(name).toHaveAttribute('data-user-text');
    expect(name.className).toContain('line-clamp-2');
    expect(name.parentElement?.className).toContain('min-w-0');
  });
});
