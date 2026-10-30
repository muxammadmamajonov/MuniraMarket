import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
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
});

describe('payloadFromSearchParams', () => {
  it('maps the documented widget fields', () => {
    const payload = payloadFromSearchParams(
      new URLSearchParams(
        'id=5&first_name=Ann&last_name=B&username=ann&photo_url=https%3A%2F%2Ft.me%2Fa.jpg&auth_date=1700000000&hash=abc',
      ),
    );
    expect(payload).toEqual({
      id: 5,
      first_name: 'Ann',
      last_name: 'B',
      username: 'ann',
      photo_url: 'https://t.me/a.jpg',
      auth_date: 1700000000,
      hash: 'abc',
    });
  });

  it('ignores unknown fields and rejects incomplete or non-numeric input', () => {
    expect(
      payloadFromSearchParams(
        new URLSearchParams('id=5&first_name=A&auth_date=1&hash=h&is_admin=true'),
      ),
    ).toEqual({ id: 5, first_name: 'A', auth_date: 1, hash: 'h' });
    expect(
      payloadFromSearchParams(new URLSearchParams('id=x&first_name=A&auth_date=1&hash=h')),
    ).toBeNull();
    expect(
      payloadFromSearchParams(new URLSearchParams('id=5&first_name=A&auth_date=1')),
    ).toBeNull();
    expect(payloadFromSearchParams(new URLSearchParams(''))).toBeNull();
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

  it('posts the payload once and continues to the cart', async () => {
    mocks.search = 'id=5&first_name=Ann&auth_date=1&hash=h';
    mocks.loginWithWidget.mockResolvedValue(undefined);
    renderCallback();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/ru/cart'));
    expect(mocks.loginWithWidget).toHaveBeenCalledOnce();
    expect(mocks.loginWithWidget).toHaveBeenCalledWith({
      id: 5,
      first_name: 'Ann',
      auth_date: 1,
      hash: 'h',
    });
  });

  it('shows an error when the API rejects the login', async () => {
    mocks.search = 'id=5&first_name=Ann&auth_date=1&hash=h';
    mocks.loginWithWidget.mockRejectedValue(new Error('nope'));
    renderCallback();
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось войти через Telegram.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('shows an error without calling the API for a malformed callback', async () => {
    mocks.search = 'foo=bar';
    renderCallback();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.loginWithWidget).not.toHaveBeenCalled();
  });
});
