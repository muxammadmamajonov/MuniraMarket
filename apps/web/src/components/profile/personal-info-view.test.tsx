import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { PersonalInfoView, profileChanges } from './personal-info-view';
import { POLL_ATTEMPTS, POLL_INTERVAL_MS } from './use-phone-share';

interface TestUser {
  id: string;
  first_name: string;
  last_name: string | null;
  birth_date: string | null;
  phone_verified: boolean;
  phone_hint: string | null;
}

const USER: TestUser = {
  id: 'u1',
  first_name: 'Munira',
  last_name: null,
  birth_date: null,
  phone_verified: false,
  phone_hint: null,
};

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous',
  user: null as unknown,
  error: null as unknown,
  logout: vi.fn(),
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  applyUser: vi.fn(),
  refresh: vi.fn<() => Promise<unknown>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderView(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <PersonalInfoView />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

function lastBody(): unknown {
  const call = session.apiFetch.mock.calls.at(-1);
  return JSON.parse(String(call?.[1]?.body ?? 'null'));
}

beforeEach(() => {
  session.status = 'authenticated';
  session.user = { ...USER };
  session.apiFetch.mockReset();
  session.applyUser.mockReset();
  session.refresh.mockReset();
});

afterEach(() => {
  uninstallWebApp();
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('profileChanges', () => {
  const user = { ...USER, last_name: 'Karimova', birth_date: '2001-03-09' } as never;

  it('sends only what changed, trimmed; blank last name and birthday clear them', () => {
    expect(
      profileChanges(user, { firstName: ' Munira ', lastName: 'Karimova', birth: '09.03.2001' })
        .changes,
    ).toEqual({});
    expect(profileChanges(user, { firstName: 'Mo', lastName: ' ', birth: '' }).changes).toEqual({
      first_name: 'Mo',
      last_name: null,
      birth_date: null,
    });
  });

  it('reports a missing first name, a too-long name and a bad date', () => {
    expect(
      profileChanges(user, { firstName: ' ', lastName: 'x'.repeat(65), birth: '31.02.2000' })
        .errors,
    ).toEqual({ firstName: 'required', lastName: 'tooLong', birth: 'invalid' });
  });
});

describe('PersonalInfoView', () => {
  it('asks to sign in when there is no session', () => {
    session.status = 'anonymous';
    session.user = null;
    session.apiFetch.mockResolvedValue(Response.json({ telegram_oidc: { enabled: false } }));
    renderView();
    expect(screen.getByTestId('sign-in-screen')).toBeInTheDocument();
  });

  it('saves name and a typed birthday with PATCH /me; Save is enabled only when dirty', async () => {
    renderView();
    const save = screen.getByTestId('personal-save');
    expect(save).toBeDisabled();
    expect(screen.getByTestId('first-name-input')).toHaveValue('Munira');

    fireEvent.change(screen.getByTestId('last-name-input'), { target: { value: 'Karimova' } });
    // Typed digits only: the dots appear by themselves.
    fireEvent.change(screen.getByTestId('birth-date-input'), { target: { value: '09032001' } });
    expect(screen.getByTestId('birth-date-input')).toHaveValue('09.03.2001');
    expect(save).toBeEnabled();

    const updated = { ...USER, last_name: 'Karimova', birth_date: '2001-03-09' };
    session.apiFetch.mockResolvedValue(Response.json({ user: updated }));
    fireEvent.click(save);
    await waitFor(() => expect(session.applyUser).toHaveBeenCalledWith(updated));
    const [path, init] = session.apiFetch.mock.calls[0] ?? [];
    expect(path).toBe('/me');
    expect(init?.method).toBe('PATCH');
    expect(lastBody()).toEqual({ last_name: 'Karimova', birth_date: '2001-03-09' });
    expect(screen.getByTestId('personal-notice')).toHaveTextContent('Saqlandi');
  });

  it('refuses an empty first name and a future birthday without calling the API', () => {
    renderView();
    fireEvent.change(screen.getByTestId('first-name-input'), { target: { value: '  ' } });
    fireEvent.change(screen.getByTestId('birth-date-input'), { target: { value: '01.01.2999' } });
    fireEvent.click(screen.getByTestId('personal-save'));
    expect(screen.getByText('Ismingizni kiriting')).toBeInTheDocument();
    expect(screen.getByText('Sana kelajakda bo‘lishi mumkin emas')).toBeInTheDocument();
    expect(screen.getByTestId('first-name-input')).toHaveAttribute('aria-invalid', 'true');
    expect(session.apiFetch).not.toHaveBeenCalled();
  });

  it('picks the birthday in the date wheel (keyboard), bounded to today', () => {
    renderView();
    fireEvent.click(screen.getByTestId('birth-date-picker'));
    const wheel = screen.getByTestId('date-wheel');
    const year = within(wheel).getByRole('listbox', { name: 'Yil' });
    // Starts at 01.01.2000 when empty.
    expect(within(year).getByRole('option', { selected: true })).toHaveTextContent('2000');
    fireEvent.keyDown(year, { key: 'ArrowDown' });
    const month = within(wheel).getByRole('listbox', { name: 'Oy' });
    fireEvent.click(within(month).getByRole('option', { name: 'Mart' }));
    fireEvent.click(within(wheel).getByRole('option', { name: '9' }));
    fireEvent.click(screen.getByTestId('date-wheel-done'));
    expect(screen.getByTestId('birth-date-input')).toHaveValue('09.03.2001');

    // End of the year wheel is this year; nothing after today can be chosen.
    fireEvent.click(screen.getByTestId('birth-date-picker'));
    const again = screen.getAllByTestId('date-wheel').at(-1) as HTMLElement;
    fireEvent.keyDown(within(again).getByRole('listbox', { name: 'Yil' }), { key: 'End' });
    fireEvent.click(within(again).getByRole('option', { name: 'Dekabr' }));
    fireEvent.click(within(again).getByTestId('date-wheel-done'));
    const [dd, mm, yyyy] = String(
      (screen.getByTestId('birth-date-input') as HTMLInputElement).value,
    ).split('.');
    const picked = `${yyyy ?? ''}-${mm ?? ''}-${dd ?? ''}`;
    expect(picked <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)).toBe(true);
  });

  it('shows the phone state subtly: verified vs typed (not verified)', () => {
    session.user = { ...USER, phone_verified: true, phone_hint: '+998 •• ••• 45 67' };
    const { unmount } = renderView();
    expect(screen.getByTestId('phone-value')).toHaveTextContent('+998 •• ••• 45 67');
    expect(screen.getByTestId('phone-state')).toHaveAttribute('data-verified', 'true');
    expect(screen.getByTestId('phone-state')).toHaveTextContent('Tasdiqlangan');
    unmount();

    session.user = { ...USER, phone_verified: false, phone_hint: '+998 •• ••• 11 22' };
    renderView('ru');
    expect(screen.getByTestId('phone-state')).toHaveTextContent('Не подтверждён');
    expect(screen.getByText(/Введённый вручную номер не подтверждается/)).toBeInTheDocument();
  });

  it('types a number with the +998 mask and saves it (unverified)', async () => {
    renderView();
    expect(screen.getByTestId('phone-value')).toHaveTextContent('Raqam qo‘shilmagan');
    fireEvent.click(screen.getByTestId('phone-change'));
    const input = screen.getByTestId('phone-manual-input');
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: '90123' } });
    expect(input).toHaveValue('90 123');
    fireEvent.click(screen.getByTestId('phone-manual-save'));
    expect(screen.getByText('Raqamni oxirigacha kiriting')).toBeInTheDocument();
    expect(session.apiFetch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '+998 (90) 123-45-67' } });
    expect(input).toHaveValue('90 123 45 67');
    const updated = { ...USER, phone_hint: '+998 •• ••• 45 67', phone_verified: false };
    session.apiFetch.mockResolvedValue(Response.json({ user: updated }));
    fireEvent.click(screen.getByTestId('phone-manual-save'));
    await waitFor(() => expect(session.applyUser).toHaveBeenCalledWith(updated));
    expect(lastBody()).toEqual({ phone: '+998901234567' });
    expect(screen.getByTestId('personal-notice')).toHaveTextContent('Raqam saqlandi');
  });

  it('shares the Telegram contact and waits for the bot to verify it', async () => {
    vi.useFakeTimers();
    const requestContact = vi.fn((callback?: (shared: boolean) => void) => callback?.(true));
    installWebApp(makeWebApp({ requestContact, isVersionAtLeast: () => true }));
    session.refresh
      .mockResolvedValueOnce({ ...USER })
      .mockResolvedValueOnce({ ...USER, phone_verified: true, phone_hint: '+998 •• ••• 45 67' });
    renderView();
    fireEvent.click(screen.getByTestId('phone-change'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('phone-share'));
    });
    expect(requestContact).toHaveBeenCalledOnce();
    expect(screen.getByTestId('phone-share')).toHaveTextContent('Telegram’dan tasdiq kutilmoqda…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(session.refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('personal-notice')).toHaveTextContent('Saqlandi');
  });

  it('says so when the contact is not shared, and times out honestly (StrictMode)', async () => {
    vi.useFakeTimers();
    let answer = false;
    const requestContact = vi.fn((callback?: (shared: boolean) => void) => callback?.(answer));
    installWebApp(makeWebApp({ requestContact, isVersionAtLeast: () => true }));
    session.refresh.mockResolvedValue({ ...USER });
    render(
      <StrictMode>
        <LocaleProvider locale="uz">
          <TelegramProvider>
            <PersonalInfoView />
          </TelegramProvider>
        </LocaleProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId('phone-change'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('phone-share'));
    });
    expect(screen.getByText(/Raqam ulashilmadi/)).toBeInTheDocument();

    answer = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId('phone-share'));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * POLL_ATTEMPTS + 10);
    });
    expect(screen.getByText(/Tasdiq hali kelmadi/)).toBeInTheDocument();
  });
});
