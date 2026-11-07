import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './select';

const OPTIONS: SelectOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana', disabled: true },
  { value: 'cherry', label: 'Cherry' },
  { value: 'cucumber', label: 'Cucumber' },
];

function Harness({
  initial = '',
  onChange = () => {},
  onOuterKeyDown,
}: {
  initial?: string;
  onChange?: (value: string) => void;
  onOuterKeyDown?: (key: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div onKeyDown={(event) => onOuterKeyDown?.(event.key)}>
      <span id="fruit-label">Fruit</span>
      <Select
        labelledBy="fruit-label"
        value={value}
        placeholder="Any fruit"
        options={OPTIONS}
        testId="fruit"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </div>
  );
}

describe('Select (custom combobox, never a native <select>)', () => {
  it('is a labelled combobox showing the current choice, closed by default', () => {
    render(<Harness initial="cherry" />);
    const combo = screen.getByRole('combobox', { name: /Fruit/ });
    expect(combo).toHaveTextContent('Cherry');
    expect(combo).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
  });

  it('opens with a click, marks the selected option and chooses with a click', () => {
    const onChange = vi.fn();
    render(<Harness initial="apple" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveTextContent('Cherry');
  });

  it('works from the keyboard and skips disabled options', () => {
    const onChange = vi.fn();
    render(<Harness initial="apple" onChange={onChange} />);
    const combo = screen.getByRole('combobox');
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    // Opens on the selected option.
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Apple' }).id,
    );
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    // "Banana" is disabled: straight to "Cherry".
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Cherry' }).id,
    );
    fireEvent.keyDown(combo, { key: 'End' });
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Cucumber' }).id,
    );
    fireEvent.keyDown(combo, { key: 'Home' });
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Any fruit' }).id,
    );
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled(); // Apple was already chosen.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ignores a click on a disabled option', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('type-ahead jumps to the next matching label', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const combo = screen.getByRole('combobox');
    fireEvent.keyDown(combo, { key: 'c' });
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Cherry' }).id,
    );
    fireEvent.keyDown(combo, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('cherry');
  });

  it('Escape closes only the list, not a dialog around it', () => {
    const outer = vi.fn();
    render(<Harness onOuterKeyDown={outer} />);
    const combo = screen.getByRole('combobox');
    fireEvent.click(combo);
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outer).not.toHaveBeenCalledWith('Escape');
    // Closed: Escape now reaches the dialog as usual.
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(outer).toHaveBeenCalledWith('Escape');
  });

  it('closes on a press outside', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does nothing while disabled', () => {
    render(
      <>
        <span id="l">Fruit</span>
        <Select labelledBy="l" value="" options={OPTIONS} onChange={() => {}} disabled />
      </>,
    );
    const combo = screen.getByRole('combobox');
    expect(combo).toBeDisabled();
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
