import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
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

  it('anonymous: the branded sign-in screen, then only Language and Help', async () => {
    renderProfile();
    expect(screen.getByTestId('sign-in-screen')).toHaveTextContent('Telegram orqali kiring');
    expect(
      await screen.findByText('Savatdan foydalanish uchun saytni Telegram orqali oching.'),
    ).toBeInTheDocument();
    const language = screen.getByTestId('profile-language-row');
    expect(language).toHaveAttribute('href', '/uz/profile/language');
    expect(language).toHaveTextContent('Til');
    expect(language).toHaveTextContent('O‘zbekcha');
    expect(screen.getByRole('link', { name: /Yordam/ })).toHaveAttribute('href', '/uz/help');
    expect(screen.queryByTestId('profile-personal-row')).toBeNull();
    expect(screen.queryByRole('button', { name: /Chiqish/ })).toBeNull();
  });

  it('authenticated (browser): account card, grouped rows to every page, sign out', () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: 'Karimova', username: 'munira' };
    renderProfile();
    const card = screen.getByTestId('profile-card');
    expect(card).toHaveAttribute('href', '/uz/profile/personal');
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Munira Karimova');
    expect(within(card).getByText('@munira')).toBeInTheDocument();

    const account = screen.getByRole('region', { name: 'Hisob' });
    const rows = within(account).getAllByRole('link');
    expect(rows.map((row) => [row.textContent, row.getAttribute('href')])).toEqual([
      ['Shaxsiy ma’lumotlar', '/uz/profile/personal'],
      ['Buyurtmalarim', '/uz/orders'],
      ['Manzillarim', '/uz/profile/addresses'],
    ]);
    expect(screen.getByRole('region', { name: 'Sozlamalar' })).toHaveTextContent('Til');

    screen.getByRole('button', { name: 'Chiqish' }).click();
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it('shows the masked phone on the card; the Mini App has no sign out', () => {
    installWebApp(makeWebApp());
    session.status = 'authenticated';
    session.user = {
      first_name: 'Munira',
      last_name: null,
      phone_verified: true,
      phone_hint: '+998 •• ••• 45 67',
    };
    renderProfile('ru');
    expect(screen.getByTestId('profile-phone')).toHaveTextContent('+998 •• ••• 45 67');
    expect(screen.getByRole('region', { name: 'Аккаунт' })).toHaveTextContent('Мои адреса');
    expect(screen.getByTestId('profile-language-row')).toHaveTextContent('Русский');
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull();
    expect(screen.getByText('Вы вошли через аккаунт Telegram.')).toBeInTheDocument();
  });

  it('says when no phone is set (and no username)', () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null, username: null, phone_hint: null };
    renderProfile();
    expect(screen.getByTestId('profile-card')).toHaveTextContent('Telefon raqami qo‘shilmagan');
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
