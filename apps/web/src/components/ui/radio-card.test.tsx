import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadioCard } from './radio-card';

describe('RadioCard', () => {
  it('keeps a real visually-hidden radio and draws its own dot', () => {
    const onChange = vi.fn();
    const { container } = render(
      <RadioCard name="pay" value="cash" checked={false} onChange={onChange}>
        Cash
      </RadioCard>,
    );
    const radio = screen.getByRole('radio', { name: 'Cash' });
    expect(radio).toHaveAttribute('type', 'radio');
    expect(radio).toHaveAttribute('name', 'pay');
    expect(radio.className).toContain('sr-only');
    expect(radio.className).not.toContain('accent-');
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain('border-border-strong');
    expect(dot?.className).toContain('group-has-checked:border-primary');
    expect(dot?.firstElementChild?.className).toContain('bg-primary');
    fireEvent.click(radio);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reflects checked and disabled', () => {
    render(
      <RadioCard name="pay" value="card" checked disabled onChange={() => undefined}>
        Card
      </RadioCard>,
    );
    const radio = screen.getByRole('radio', { name: 'Card' });
    expect(radio).toBeChecked();
    expect(radio).toBeDisabled();
  });
});
