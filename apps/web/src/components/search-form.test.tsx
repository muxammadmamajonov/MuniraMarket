import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDictionary } from '@/i18n';
import { SearchForm } from './search-form';

const dict = getDictionary('uz');

describe('SearchForm', () => {
  it('is a plain GET search form with a text field (no browser search "x")', () => {
    render(<SearchForm locale="uz" dict={dict} />);
    const form = screen.getByRole('search', { name: dict.search.label });
    expect(form).toHaveAttribute('action', '/uz/search');
    expect(form).toHaveAttribute('method', 'get');
    const input = screen.getByRole('searchbox', { name: dict.search.label });
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('name', 'q');
    expect(input).toHaveAttribute('enterkeyhint', 'search');
    expect(screen.queryByRole('button', { name: dict.search.clear })).toBeNull();
  });

  it('shows its own clear button once there is text; it empties the field and refocuses it', () => {
    render(<SearchForm locale="uz" dict={dict} defaultValue="olma" />);
    const input = screen.getByRole('searchbox');
    expect(input).toHaveValue('olma');
    fireEvent.click(screen.getByRole('button', { name: dict.search.clear }));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: dict.search.clear })).toBeNull();
    fireEvent.change(input, { target: { value: 'nok' } });
    expect(screen.getByRole('button', { name: dict.search.clear })).toBeInTheDocument();
  });
});
