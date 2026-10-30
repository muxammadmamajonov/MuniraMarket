import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { beginLoginState } from '@/lib/auth/login-state';
import { LoginCallback, payloadFromSearchParams } from './login-callback';

const mocks = vi.hoisted(() => ({
  search: '',
  replace: vi.fn(),
  loginWithWidget: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/lib/session', () => ({
  useSession: () => ({ loginWithWidget: mocks.loginWithWidget }),
}));

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.loginWithWidget.mockReset();
  window.sessionStorage.clear();
});

/** Query string as the widget produces it after a login this tab started. */
function startedLogin(fields: string): string {
  return `state=${beginLoginState() ?? ''}&${fields}`;
}

describe('payloadFromSearchParams', () => {
  it('maps the documented widget fields and ignores everything else', () => {
    expect(
      payloadFromSearchParams(
        new URLSearchParams(
          'id=5&first_name=T&last_name=B&username=t&photo_url=https%3A%2F%2Ft.me%2Fa.jpg&auth_date=1700000000&hash=abc&role=admin',
        ),
      ),
    ).toEqual({
      id: 5,
      first_name: 'T',
      last_name: 'B',
      username: 't',
      photo_url: 'https://t.me/a.jpg',
      auth_date: 1700000000,
      hash: 'abc',
    });
  });

  it('rejects incomplete or non-numeric input', () => {
    expect(
      payloadFromSearchParams(new URLSearchParams('id=x&first_name=A&auth_date=1&hash=h')),
    ).toBeNull();
    expect(
      payloadFromSearchParams(new URLSearchParams('id=5&first_name=A&auth_date=1')),
    ).toBeNull();
  });
});

describe('LoginCallback', () => {
  function renderCallback() {
    return render(
      <LocaleProvider locale="ru">
        <LoginCallback />
      </LocaleProvider>,
    );
  }

  it('posts the payload once and continues to the orders list', async () => {
    mocks.search = startedLogin('id=5&first_name=T&auth_date=1&hash=h');
    mocks.loginWithWidget.mockResolvedValue(undefined);
    renderCallback();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/ru'));
    expect(mocks.loginWithWidget).toHaveBeenCalledOnce();
  });

  it('shows an error when the API rejects the login', async () => {
    mocks.search = startedLogin('id=5&first_name=T&auth_date=1&hash=h');
    mocks.loginWithWidget.mockRejectedValue(new Error('nope'));
    renderCallback();
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось войти через Telegram.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('refuses a validly signed payload this tab did not ask for (login CSRF)', async () => {
    mocks.search = `state=${'a'.repeat(32)}&id=666&first_name=X&auth_date=1&hash=h`;
    renderCallback();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.loginWithWidget).not.toHaveBeenCalled();
  });

  it('refuses a malformed callback without calling the API', async () => {
    mocks.search = startedLogin('foo=bar');
    renderCallback();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.loginWithWidget).not.toHaveBeenCalled();
  });
});
