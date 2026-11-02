import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSwitcher } from './language-switcher';

vi.mock('next/navigation', () => ({
  usePathname: () => '/uz/cart',
}));

const names = { uz: 'O‘zbekcha', ru: 'Русский' };

afterEach(() => {
  document.cookie = 'locale=; Path=/; Max-Age=0';
});

describe('LanguageSwitcher', () => {
  it('links to the same page in every locale and marks the current one', () => {
    render(<LanguageSwitcher locale="uz" label="Language" names={names} />);

    expect(screen.getByRole('navigation', { name: 'Language' })).toBeInTheDocument();
    const uz = screen.getByRole('link', { name: names.uz });
    const ru = screen.getByRole('link', { name: names.ru });
    expect(uz).toHaveAttribute('href', '/uz/cart');
    expect(uz).toHaveAttribute('aria-current', 'true');
    expect(ru).toHaveAttribute('href', '/ru/cart');
    expect(ru).not.toHaveAttribute('aria-current');
  });

  it('stores the chosen language in the locale cookie on click', () => {
    render(<LanguageSwitcher locale="uz" label="Language" names={names} />);
    // jsdom cannot navigate; swallow the default action after React has handled the click.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole('link', { name: names.ru }), { button: 0 });
    expect(document.cookie).toContain('locale=ru');
  });
});

describe('LanguageSwitcher (compact)', () => {
  it('is one link to the other language, named by the full language name', () => {
    render(
      <LanguageSwitcher
        compact
        locale="uz"
        label="Language"
        names={names}
        shortNames={{ uz: 'UZ', ru: 'RU' }}
      />,
    );
    const link = screen.getByRole('link', { name: names.ru });
    expect(link).toHaveTextContent('RU');
    expect(link).toHaveAttribute('href', '/ru/cart');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('stores the choice in the locale cookie', () => {
    render(
      <LanguageSwitcher
        compact
        locale="ru"
        label="Language"
        names={names}
        shortNames={{ uz: 'UZ', ru: 'RU' }}
      />,
    );
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(screen.getByRole('link', { name: names.uz }), { button: 0 });
    expect(document.cookie).toContain('locale=uz');
  });
});
