import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { LanguageSetting } from './language-setting';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/uz/profile/language',
  useRouter: () => ({ replace: nav.replace }),
}));

const session = vi.hoisted(() => ({
  status: 'anonymous' as 'authenticated' | 'anonymous',
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  applyUser: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderSetting() {
  return render(
    <LocaleProvider locale="uz">
      <LanguageSetting />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'anonymous';
  session.apiFetch.mockReset();
  session.applyUser.mockReset();
  nav.replace.mockReset();
  document.cookie = 'locale=; Max-Age=0; Path=/';
});

describe('LanguageSetting', () => {
  it('is a checkmark list with the current language checked', () => {
    renderSetting();
    expect(screen.getByRole('radio', { name: 'O‘zbekcha' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Русский' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Do‘kon va bot xabarlari shu tilda bo‘ladi.')).toBeInTheDocument();
  });

  it('anonymous: kept in the browser cookie and applied at once', () => {
    renderSetting();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(session.apiFetch).not.toHaveBeenCalled();
    expect(document.cookie).toContain('locale=ru');
    expect(nav.replace).toHaveBeenCalledWith('/ru/profile/language');
  });

  it('signed in: saved to the account (the bot uses it too), then the URL follows', async () => {
    session.status = 'authenticated';
    const saved = { first_name: 'Munira', language: 'ru' };
    session.apiFetch.mockResolvedValue(Response.json({ user: saved }));
    renderSetting();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/ru/profile/language'));
    expect(session.apiFetch).toHaveBeenCalledWith(
      '/me/language',
      expect.objectContaining({ method: 'PUT', body: '{"language":"ru"}' }),
    );
    expect(session.applyUser).toHaveBeenCalledWith(saved);
  });

  it('keeps the page and explains when the language could not be saved', async () => {
    session.status = 'authenticated';
    session.apiFetch.mockResolvedValue(new Response(null, { status: 503 }));
    renderSetting();
    fireEvent.click(screen.getByRole('radio', { name: 'Русский' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tilni saqlab bo‘lmadi');
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
