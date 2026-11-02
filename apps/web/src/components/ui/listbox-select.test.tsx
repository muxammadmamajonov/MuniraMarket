import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ListboxSelect, type ListboxGroup, type ListboxOption } from './listbox-select';

const FRUIT: ListboxOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot', disabled: true },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

const GROUPS: ListboxGroup[] = [
  { id: 'a', label: 'Zone A — 10 000', options: [{ value: 'x', label: 'Xylem' }] },
  {
    id: 'b',
    label: 'Zone B — free',
    options: [
      { value: 'y', label: 'Yarrow' },
      { value: 'z', label: 'Zinnia' },
    ],
  },
];

function Harness({
  initial = '',
  onChange = () => undefined,
  ...rest
}: {
  initial?: string;
  onChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  groups?: ListboxGroup[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="fruit">Fruit</label>
      <ListboxSelect
        id="fruit"
        label="Fruit"
        placeholder="Pick one"
        value={value}
        {...(rest.groups === undefined ? { options: FRUIT } : { groups: rest.groups })}
        {...(rest.name === undefined ? {} : { name: rest.name })}
        {...(rest.disabled === undefined ? {} : { disabled: rest.disabled })}
        aria-describedby="fruit-error"
        aria-invalid
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <p id="fruit-error">Required</p>
      <button type="button">after</button>
    </>
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Fruit' });
const key = (name: string) => fireEvent.keyDown(trigger(), { key: name });

describe('ListboxSelect', () => {
  it('renders a labelled combobox trigger with the placeholder and the ARIA wiring', () => {
    render(<Harness />);
    const button = trigger();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'listbox');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-invalid', 'true');
    expect(button).toHaveAccessibleDescription('Required');
    expect(button).toHaveTextContent('Pick one');
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('text-base');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click, wires aria-controls and marks the selected option', () => {
    render(<Harness initial="banana" />);
    expect(trigger()).toHaveTextContent('Banana');
    fireEvent.click(trigger());
    const list = screen.getByRole('listbox', { name: 'Fruit' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', list.id);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Apple', 'Apricot', 'Banana', 'Cherry']);
    expect(screen.getByRole('option', { name: 'Banana', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Apple', selected: false })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[2]?.id);
    expect(options[1]).toHaveAttribute('aria-disabled', 'true');
    for (const option of options) expect(option.className).toContain('min-h-11');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('overscroll-contain');
    expect(list.className).toContain('ease-out-strong');
    expect(list.className).toContain('origin-top');
    expect(list.className).toContain('motion-reduce:transition-none');
  });

  it('chooses with a click, calls onChange once and closes', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('cherry');
    expect(trigger()).toHaveTextContent('Cherry');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
  });

  it('does not choose a disabled option', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'Apricot' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it.each(['Enter', ' ', 'ArrowDown', 'ArrowUp'])('opens with %j', (name) => {
    render(<Harness />);
    trigger().focus();
    key(name);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves with the arrows (skipping disabled options), Home and End, then chooses with Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key('ArrowDown'); // opens on the first enabled option
    const options = screen.getAllByRole('option');
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    key('ArrowDown'); // skips the disabled Apricot
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[2]?.id);
    key('End');
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[3]?.id);
    key('ArrowDown'); // stays on the last
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[3]?.id);
    key('Home');
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    key('ArrowUp');
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    key('ArrowDown');
    key('Enter');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('banana');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('chooses with Space', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key('Enter');
    key('End');
    key(' ');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('cherry');
  });

  it('jumps by type-ahead, extending the prefix and skipping disabled options', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      key('Enter');
      const options = screen.getAllByRole('option');
      key('c');
      expect(trigger()).toHaveAttribute('aria-activedescendant', options[3]?.id);
      act(() => {
        vi.advanceTimersByTime(700); // the buffer resets
      });
      key('b');
      expect(trigger()).toHaveAttribute('aria-activedescendant', options[2]?.id);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      // "ap" would match Apricot first, but it is disabled: Apple wins.
      key('a');
      key('p');
      expect(trigger()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens and jumps when a letter is typed on the closed trigger', () => {
    render(<Harness />);
    key('b');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute(
      'aria-activedescendant',
      screen.getAllByRole('option')[2]?.id,
    );
  });

  it('closes on Escape without choosing and keeps focus on the trigger', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    key('Enter');
    key('ArrowDown');
    key('Escape');
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveTextContent('Pick one');
  });

  it('closes on Tab without choosing', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    key('Enter');
    key('ArrowDown');
    key('Tab');
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on a press outside, but not inside the list', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole('listbox'));
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(screen.getByText('after'));
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles closed on a second click of the trigger', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('highlights the hovered option', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const cherry = screen.getByRole('option', { name: 'Cherry' });
    fireEvent.mouseMove(cherry);
    expect(trigger()).toHaveAttribute('aria-activedescendant', cherry.id);
  });

  it('renders groups with accessible names, and a hidden input for native form submission', () => {
    const { container } = render(<Harness groups={GROUPS} name="plant" initial="z" />);
    expect(trigger()).toHaveTextContent('Zinnia');
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="plant"]');
    expect(hidden?.value).toBe('z');
    fireEvent.click(trigger());
    const groupB = screen.getByRole('group', { name: 'Zone B — free' });
    expect(screen.getByRole('group', { name: 'Zone A — 10 000' })).toBeInTheDocument();
    expect(groupB.querySelectorAll('[role="option"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('option', { name: 'Xylem' }));
    expect(hidden?.value).toBe('x');
  });

  it('renders no hidden input without a name', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input')).toBeNull();
  });

  it('does not open when disabled', () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('unmounts the list after the exit animation and hides it from assistive tech meanwhile', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.click(trigger());
      fireEvent.click(trigger());
      expect(screen.queryByRole('listbox')).toBeNull(); // aria-hidden while it fades out
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(document.querySelector('[role="listbox"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
