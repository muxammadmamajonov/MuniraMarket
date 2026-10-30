import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Price } from './price';

describe('Price', () => {
  it('renders the formatted price', () => {
    render(<Price amount={12500} locale="uz" data-testid="p" />);
    expect(screen.getByTestId('p').textContent).toBe('12\u00A0500\u00A0so\u2018m');
    expect(screen.queryByText(/./, { selector: 'del' })).toBeNull();
  });

  it('renders ru', () => {
    render(<Price amount={5000} locale="ru" data-testid="p" />);
    expect(screen.getByTestId('p').textContent).toBe('5\u00A0000\u00A0\u0441\u0443\u043C');
  });

  it('strikes through the old price', () => {
    const { container } = render(<Price amount={9000} oldAmount={12000} locale="uz" />);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('12\u00A0000\u00A0so\u2018m');
  });

  it('adds screen-reader labels when provided', () => {
    render(
      <Price
        amount={9000}
        oldAmount={12000}
        locale="ru"
        currentLabel="Цена"
        oldLabel="Старая цена"
        data-testid="p"
      />,
    );
    const el = screen.getByTestId('p');
    expect(el).toHaveTextContent('Цена');
    expect(el).toHaveTextContent('Старая цена');
    expect(screen.getByText(/Цена/, { selector: '.sr-only' })).toBeInTheDocument();
  });

  it('propagates RangeError for invalid amounts', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Price amount={1.5} locale="uz" />)).toThrow(RangeError);
    } finally {
      error.mockRestore();
    }
  });
});
