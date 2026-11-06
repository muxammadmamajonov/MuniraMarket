import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { ProfileView, initialOf } from './profile-view';

vi.mock('next/navigation', () => ({ usePathname: () => '/uz/profile' }));

const session = vi.hoisted(() => ({
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null as null | { first_name: string; last_name: string | null },
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
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
  session.apiFetch.mockResolvedValue(Response.json({ telegram_oidc: { enabled: false } }));
});

afterEach(() => {
  uninstallWebApp();
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

  it('anonymous (browser): explains sign-in and offers the shared sign-in prompt and language', async () => {
    renderProfile();
    expect(screen.getByTestId('profile-anonymous')).toHaveTextContent('Hisobingizga kiring');
    expect(
      await screen.findByText('Savatdan foydalanish uchun saytni Telegram orqali oching.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Русский' })).toHaveAttribute('href', '/ru/profile');
    expect(screen.queryByRole('button', { name: 'Chiqish' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Buyurtmalarim' })).toBeNull();
  });

  it('authenticated (browser): name, orders, language and sign out', () => {
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: 'Karimova' };
    renderProfile();
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Munira Karimova');
    expect(screen.getByRole('link', { name: 'Buyurtmalarim' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    screen.getByRole('button', { name: 'Chiqish' }).click();
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it('inside the Mini App there is nothing to sign out of', () => {
    installWebApp(makeWebApp());
    session.status = 'authenticated';
    session.user = { first_name: 'Munira', last_name: null };
    renderProfile('ru');
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Munira');
    expect(screen.getByRole('link', { name: 'Мои заказы' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull();
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
    expect(name.className).toContain('min-w-0');
  });
});
