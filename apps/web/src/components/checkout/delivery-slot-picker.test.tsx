import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { slotOption, slotQuote } from '@/lib/checkout/test-fixtures';
import { DeliverySlotPicker, type DeliverySlotPickerProps } from './delivery-slot-picker';

const TODAY = '2026-10-31';
const IDS = ['1', '2', '3', '4'].map((n) => `5a000000-0000-4000-8000-00000000000${n}`);
const [TODAY_LOW, TODAY_FULL, TOMORROW, LATER] = IDS as [string, string, string, string];

function renderPicker(props: Partial<DeliverySlotPickerProps> = {}, locale: 'uz' | 'ru' = 'uz') {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const tree = (extra: Partial<DeliverySlotPickerProps>) => (
    <LocaleProvider locale={locale}>
      <DeliverySlotPicker
        slots={slotQuote().delivery_slots}
        selectedId={null}
        required
        disabled={false}
        stale={false}
        notice={null}
        onSelect={onSelect}
        onClear={onClear}
        today={TODAY}
        {...props}
        {...extra}
      />
    </LocaleProvider>
  );
  const view = render(tree({}));
  return {
    ...view,
    onSelect,
    onClear,
    /** Re-render with other props (same component instance, so state is kept). */
    update: (extra: Partial<DeliverySlotPickerProps>) => view.rerender(tree(extra)),
  };
}

const group = () => screen.getByRole('radiogroup', { name: 'Yetkazish vaqti' });
const tabs = () => screen.getAllByRole('tab');
const tab = (name: RegExp | string) => screen.getByRole('tab', { name });
const option = (id: string) =>
  screen
    .getAllByTestId('delivery-slot-option')
    .find((element) => element.getAttribute('data-slot-id') === id) as HTMLElement;
const shownRadios = () => within(group()).getAllByRole('radio');
const key = (element: HTMLElement, name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(element, { key: name, ...init });

afterEach(() => vi.restoreAllMocks());

describe('DeliverySlotPicker: day chips', () => {
  it('shows one chip per day: today and tomorrow by word, later days by weekday, dated, with a free count', () => {
    renderPicker();
    expect(tabs().map((element) => element.getAttribute('data-date'))).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-03',
    ]);
    const [today, tomorrow, later] = tabs() as [HTMLElement, HTMLElement, HTMLElement];
    expect(today).toHaveTextContent('Bugun31.101 ta bo‘sh');
    expect(tomorrow).toHaveTextContent('Ertaga01.111 ta bo‘sh');
    expect(later).toHaveTextContent('Seshanba03.111 ta bo‘sh');
    expect(today).toHaveAccessibleName('Bugun, 31.10, 1 ta bo‘sh');
  });

  it('counts windows that can be booked, not places, and ignores full ones', () => {
    renderPicker({
      slots: [
        slotOption({ id: 'a', starts_at: '08:00', ends_at: '09:00' }),
        slotOption({ id: 'b', starts_at: '09:00', ends_at: '10:00', remaining: 1 }),
        slotOption({ id: 'c', starts_at: '10:00', ends_at: '11:00', is_full: true, remaining: 0 }),
        slotOption({ id: 'd', starts_at: '11:00', ends_at: '12:00', remaining: 0 }),
      ],
    });
    expect(tab(/Bugun/)).toHaveTextContent('2 ta bo‘sh');
  });

  it('keeps a fully booked day in the row, marked "full", and still lets you open it', () => {
    renderPicker({
      slots: [
        slotOption({ id: 'a', date: '2026-10-31', is_full: true, remaining: 0 }),
        slotOption({ id: 'b', date: '2026-11-01' }),
      ],
    });
    const full = tab(/Bugun/);
    expect(full).toHaveAttribute('data-full', 'true');
    expect(full).toHaveTextContent('To‘lgan');
    expect(full).toHaveAccessibleName('Bugun, 31.10, To‘lgan');
    expect(full).not.toHaveAttribute('aria-disabled');
    // It is not the default day, but it can be opened to see the booked windows.
    expect(tab(/Ertaga/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(full);
    expect(full).toHaveAttribute('aria-selected', 'true');
    const [radio] = shownRadios();
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription('To‘lgan');
  });

  it('is a labelled tablist whose chips are 56px targets that never shrink or truncate', () => {
    renderPicker();
    expect(screen.getByRole('tablist', { name: 'Yetkazish kuni' })).toBeInTheDocument();
    for (const element of tabs()) {
      expect(element.className).toContain('min-h-14');
      expect(element.className).toContain('shrink-0');
      expect(element.className).toContain('whitespace-nowrap');
      expect(element.className).toContain('snap-start');
      // Controls are not text to select, and respond to a tap without the double-tap delay.
      expect(element.className).toContain('select-none');
      expect(element.className).toContain('touch-manipulation');
    }
    // Press feedback only while the chip can be used.
    expect(tab(/Bugun/).className).toContain('active:scale-[0.97]');
  });

  it('scrolls on its own (the page never does) and snaps, with safe-area scroll padding', () => {
    renderPicker();
    const row = screen.getByTestId('delivery-day-row');
    expect(row.className).toContain('overflow-x-auto');
    expect(row.className).toContain('snap-x');
    expect(row.className).toContain('snap-mandatory');
    expect(row.className).toContain('overscroll-x-contain');
    expect(row.className).toContain('env(safe-area-inset-left');
    expect(row.className).toContain('env(safe-area-inset-right');
    // Bleeds to the card's edges so chips scroll out under them, not under the card's padding.
    expect(row.className).toContain('-mx-4');
  });
});

describe('DeliverySlotPicker: ARIA', () => {
  it('has exactly one selected tab, in the tab order, and a panel labelled by it', () => {
    renderPicker();
    const selected = tabs().filter((element) => element.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    for (const element of tabs()) {
      expect(element).toHaveAttribute('tabindex', element === selected[0] ? '0' : '-1');
    }
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', (selected[0] as HTMLElement).id);
    expect(selected[0]).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('data-day', '2026-10-31');
  });

  it('keeps one radiogroup, "delivery time", required and described, around the shown windows', () => {
    renderPicker();
    expect(group()).toHaveAttribute('aria-required', 'true');
    expect(group()).toHaveAccessibleDescription('Buyurtma berish uchun yetkazish vaqtini tanlang.');
    expect(group()).toHaveAttribute('data-field', 'deliverySlot');
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    const radios = shownRadios();
    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(
      new Set(['deliverySlot']),
    );
  });

  it('writes each window as HH:MM–HH:MM and names every radio with its day', () => {
    renderPicker();
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeInTheDocument();
    fireEvent.click(tab(/Ertaga/));
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeInTheDocument();
    fireEvent.click(tab(/Seshanba/));
    expect(screen.getByRole('radio', { name: 'Seshanba, 03.11, 16:00–18:00' })).toBeInTheDocument();
  });

  it('exposes stable test hooks on every option, in every day', () => {
    renderPicker();
    const options = screen.getAllByTestId('delivery-slot-option');
    expect(options.map((element) => element.getAttribute('data-slot-id'))).toEqual(IDS);
  });
});

describe('DeliverySlotPicker: default day', () => {
  it('opens on the first day with a window that can be booked', () => {
    renderPicker();
    expect(tab(/Bugun/)).toHaveAttribute('aria-selected', 'true');
  });

  it('skips fully booked days at the start', () => {
    renderPicker({
      slots: [
        slotOption({ id: 'a', date: '2026-10-31', is_full: true, remaining: 0 }),
        slotOption({ id: 'b', date: '2026-11-01', is_full: true, remaining: 0 }),
        slotOption({ id: 'c', date: '2026-11-03' }),
      ],
    });
    expect(tab(/Seshanba/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-day', '2026-11-03');
  });

  it('opens on the first day when every day is booked, with the "none left" note', () => {
    renderPicker({
      slots: [
        slotOption({ id: 'a', date: '2026-10-31', is_full: true, remaining: 0 }),
        slotOption({ id: 'b', date: '2026-11-01', is_full: true, remaining: 0 }),
      ],
    });
    expect(tab(/Bugun/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('slots-none')).toHaveTextContent('Hozircha bo‘sh vaqt qolmagan');
  });

  it('opens on the day of the chosen window', () => {
    renderPicker({ selectedId: LATER });
    expect(tab(/Seshanba/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: 'Seshanba, 03.11, 16:00–18:00' })).toBeChecked();
  });

  it('stays on the day the customer is looking at when the chosen window is cleared', () => {
    const { update } = renderPicker({ selectedId: LATER });
    expect(tab(/Seshanba/)).toHaveAttribute('aria-selected', 'true');
    update({ selectedId: null });
    expect(tab(/Seshanba/)).toHaveAttribute('aria-selected', 'true');
  });

  it('stays on the shown day when the chosen window fills up and the choice is dropped', () => {
    const { update } = renderPicker({ selectedId: TOMORROW });
    expect(tab(/Ertaga/)).toHaveAttribute('aria-selected', 'true');
    update({
      selectedId: null,
      notice: 'full',
      slots: slotQuote().delivery_slots.map((slot) =>
        slot.id === TOMORROW ? { ...slot, is_full: true, remaining: 0 } : slot,
      ),
    });
    expect(tab(/Ertaga/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('slot-notice')).toHaveAttribute('data-reason', 'full');
  });

  it('falls back to the default when the remembered day is no longer offered', () => {
    const { update } = renderPicker({ selectedId: LATER });
    update({
      selectedId: null,
      slots: [
        slotOption({ id: 'x', date: '2026-11-05' }),
        slotOption({ id: 'y', date: '2026-11-06' }),
      ],
    });
    expect(
      tabs()
        .filter((element) => element.getAttribute('aria-selected') === 'true')
        .map((element) => element.getAttribute('data-date')),
    ).toEqual(['2026-11-05']);
  });

  it('shows a single day as a single chip', () => {
    renderPicker({ slots: [slotOption({ id: 'only' })] });
    expect(tabs()).toHaveLength(1);
    expect(tab(/Bugun/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('DeliverySlotPicker: switching days', () => {
  it('shows only the windows of the chosen day, and hides the others from assistive technology', () => {
    renderPicker();
    expect(shownRadios()).toHaveLength(2);
    fireEvent.click(tab(/Ertaga/));
    expect(shownRadios().map((radio) => radio.getAttribute('value'))).toEqual([TOMORROW]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-day', '2026-11-01');
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    // The other panels are still laid out (so nothing moves), just invisible.
    const panels = document.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(3);
    expect(
      [...panels].filter((panel) => (panel as HTMLElement).style.visibility === 'hidden'),
    ).toHaveLength(2);
  });

  it('does not shift the layout: every day sits in the same grid cell', () => {
    renderPicker();
    for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
      expect(panel.className).toContain('col-start-1');
      expect(panel.className).toContain('row-start-1');
    }
    expect(document.querySelector('[role="tabpanel"]')?.parentElement?.className).toContain('grid');
  });

  it('keeps the chosen window selected across days, marks the chip that holds it, and says so', () => {
    const { update } = renderPicker();
    fireEvent.click(option(TODAY_LOW));
    update({ selectedId: TODAY_LOW });
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeChecked();
    expect(within(tab(/Bugun/)).getByTestId('delivery-day-chosen')).toBeInTheDocument();
    expect(tab(/Bugun/)).toHaveAccessibleName('Bugun, 31.10, 1 ta bo‘sh, tanlangan vaqt shu kunda');
    expect(screen.queryByTestId('slot-chosen-elsewhere')).toBeNull();

    // Look at another day: the choice is untouched, and the group is told where it is.
    fireEvent.click(tab(/Ertaga/));
    expect(
      screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
    expect(within(tab(/Bugun/)).getByTestId('delivery-day-chosen')).toBeInTheDocument();
    expect(within(tab(/Ertaga/)).queryByTestId('delivery-day-chosen')).toBeNull();
    expect(screen.getByTestId('slot-chosen-elsewhere')).toHaveTextContent(
      'Tanlangan vaqt: Bugun, 31.10, 10:00–12:00',
    );
    expect(group()).toHaveAccessibleDescription(
      expect.stringContaining('Tanlangan vaqt: Bugun, 31.10, 10:00–12:00'),
    );

    // And back: still checked.
    fireEvent.click(tab(/Bugun/));
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeChecked();
    expect(screen.queryByTestId('slot-chosen-elsewhere')).toBeNull();
  });

  it('selects a window by tapping its tile, in any day', () => {
    const { onSelect } = renderPicker();
    fireEvent.click(tab(/Ertaga/));
    fireEvent.click(option(TOMORROW));
    expect(onSelect).toHaveBeenCalledWith(TOMORROW);
  });

  it('shows one checked radio at most', () => {
    renderPicker({ selectedId: TOMORROW });
    fireEvent.click(tab(/Bugun/));
    fireEvent.click(tab(/Ertaga/));
    expect(
      screen.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
  });

  it('puts focus-ready, programmatic focus targets only on the shown day (the notice scrolls to it)', () => {
    renderPicker();
    expect(document.querySelectorAll('[data-field="deliverySlot"]')).toHaveLength(1);
    fireEvent.click(tab(/Seshanba/));
    expect(document.querySelectorAll('[data-field="deliverySlot"]')).toHaveLength(1);
    expect(group().closest('[data-day]')).toHaveAttribute('data-day', '2026-11-03');
  });
});

describe('DeliverySlotPicker: keyboard', () => {
  it('moves to the next and previous day with the arrow keys, with focus, wrapping at both ends', () => {
    renderPicker();
    const [first, second, third] = tabs() as [HTMLElement, HTMLElement, HTMLElement];
    first.focus();

    expect(key(first, 'ArrowRight')).toBe(false); // handled, so the page does not scroll
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(second);
    expect(second).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-day', '2026-11-01');

    key(second, 'ArrowRight');
    expect(document.activeElement).toBe(third);
    key(third, 'ArrowRight'); // wraps to the first
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
    key(first, 'ArrowLeft'); // wraps to the last
    expect(document.activeElement).toBe(third);
    key(third, 'ArrowLeft');
    expect(document.activeElement).toBe(second);
  });

  it('jumps to the first and last day with Home and End', () => {
    renderPicker();
    const [first, , third] = tabs() as [HTMLElement, HTMLElement, HTMLElement];
    first.focus();
    expect(key(first, 'End')).toBe(false);
    expect(document.activeElement).toBe(third);
    expect(third).toHaveAttribute('aria-selected', 'true');
    expect(key(third, 'Home')).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves every other key, and shortcuts with a modifier, alone', () => {
    renderPicker();
    const [first] = tabs() as [HTMLElement];
    first.focus();
    for (const name of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'a', 'Tab']) {
      expect(key(first, name)).toBe(true);
    }
    for (const init of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      expect(key(first, 'ArrowRight', init)).toBe(true);
    }
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a day on click as well, and keeps the roving tab stop on the shown day', () => {
    renderPicker();
    fireEvent.click(tab(/Seshanba/));
    expect(tab(/Seshanba/)).toHaveAttribute('tabindex', '0');
    expect(tab(/Bugun/)).toHaveAttribute('tabindex', '-1');
  });
});

describe('DeliverySlotPicker: windows', () => {
  it('calls out a nearly full window, and says nothing about a comfortable one', () => {
    renderPicker();
    expect(
      screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' }),
    ).toHaveAccessibleDescription('2 ta joy qoldi');
    fireEvent.click(tab(/Ertaga/));
    expect(
      screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' }),
    ).not.toHaveAccessibleDescription();
    expect(option(TOMORROW)).not.toHaveTextContent('joy');
  });

  it('keeps a full window visible but disabled, struck through and labelled', () => {
    const { onSelect } = renderPicker();
    const full = screen.getByRole('radio', { name: 'Bugun, 31.10, 12:00–14:00' });
    expect(full).toBeDisabled();
    expect(full).toHaveAccessibleDescription('To‘lgan');
    expect(option(TODAY_FULL)).toHaveAttribute('data-full', 'true');
    expect(option(TODAY_FULL)).toHaveTextContent('To‘lgan');
    fireEvent.click(option(TODAY_FULL));
    expect(onSelect).not.toHaveBeenCalled();
    expect(full).not.toBeChecked();
  });

  it('treats a window with no places as full even when the server did not flag it', () => {
    renderPicker({ slots: [slotOption({ id: 'x', remaining: 0, is_full: false })] });
    expect(screen.getByRole('radio')).toBeDisabled();
    expect(tab(/Bugun/)).toHaveAttribute('data-full', 'true');
  });

  it('shows the chosen window as checked', () => {
    renderPicker({ selectedId: TOMORROW });
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeChecked();
  });

  it('lays tiles out in as many columns as fit (two at 360px, one never overflows) with 56px targets', () => {
    renderPicker();
    expect(option(TODAY_LOW).className).toContain('min-h-14');
    // `auto-fill` with a minimum that fits an "HH:MM–HH:MM" time: no fixed column count that would
    // overflow at 200% zoom or 320px.
    expect(group().className).toContain('grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]');
    expect(option(TODAY_LOW).className).toContain('select-none');
    expect(option(TODAY_LOW).className).toContain('touch-manipulation');
    // Press feedback, only while the window can be chosen; reduced motion is handled globally.
    expect(option(TODAY_LOW).className).toContain('active:scale-[0.97]');
    expect(option(TODAY_FULL).className).not.toContain('active:scale');
  });

  it('renders no radio group and no chips when there are no windows at all', () => {
    renderPicker({ slots: [] });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('slots-none')).toBeInTheDocument();
  });

  it('says so when every window is taken', () => {
    renderPicker({ slots: [slotOption({ id: 'x', is_full: true, remaining: 0 })] });
    expect(screen.getByTestId('slots-none')).toHaveTextContent('Hozircha bo‘sh vaqt qolmagan');
  });

  it('offers a way to clear the choice only when a window is optional', () => {
    const { onClear, update } = renderPicker({ required: false, selectedId: TODAY_LOW });
    expect(group()).not.toHaveAttribute('aria-required');
    expect(screen.getByText('Xohlasangiz, qulay yetkazish vaqtini tanlang.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('slot-clear'));
    expect(onClear).toHaveBeenCalledOnce();
    update({ required: true });
    expect(screen.queryByTestId('slot-clear')).toBeNull();
  });
});

describe('DeliverySlotPicker: stale, disabled and notices', () => {
  it('dims and disables the windows and day chips while the windows are being refreshed', () => {
    renderPicker({ stale: true, selectedId: TODAY_LOW });
    expect(screen.getByTestId('delivery-slots')).toHaveAttribute('aria-busy', 'true');
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(group().className).toContain('opacity-60');
    expect(screen.getByTestId('delivery-day-row').className).toContain('opacity-60');
    for (const element of tabs()) expect(element).toHaveAttribute('aria-disabled', 'true');
    // The choice itself stays visible.
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeChecked();
  });

  it('ignores day changes by tap and by keyboard while inert, and keeps focus where it is', () => {
    renderPicker({ stale: true });
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    first.focus();
    fireEvent.click(second);
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(key(first, 'ArrowRight')).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
    // Focusable, not `disabled`: a chip that is briefly inert does not throw focus away.
    expect(first).not.toBeDisabled();
    expect(first.className).not.toContain('active:scale');
  });

  it('disables the choices while the order is being sent, and works again afterwards', () => {
    const { update } = renderPicker({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    fireEvent.click(tab(/Ertaga/));
    expect(tab(/Bugun/)).toHaveAttribute('aria-selected', 'true');
    update({ disabled: false });
    fireEvent.click(tab(/Ertaga/));
    expect(tab(/Ertaga/)).toHaveAttribute('aria-selected', 'true');
  });

  it.each([
    ['full', 'Bu vaqt oralig‘i to‘lib qoldi. Boshqa vaqtni tanlang.'],
    ['unavailable', 'Bu vaqt endi mavjud emas. Boshqa vaqtni tanlang.'],
    ['required', 'Buyurtma berish uchun yetkazish vaqtini tanlang.'],
  ] as const)(
    'shows the "%s" notice next to the choices and marks the shown group invalid',
    (reason, text) => {
      renderPicker({ notice: reason });
      const notice = screen.getByTestId('slot-notice');
      expect(notice).toHaveAttribute('role', 'alert');
      expect(notice).toHaveTextContent(text);
      expect(group()).toHaveAttribute('aria-invalid', 'true');
      expect(group()).toHaveAccessibleDescription(expect.stringContaining(text));
      // Still true after looking at another day.
      fireEvent.click(tab(/Ertaga/));
      expect(group()).toHaveAttribute('aria-invalid', 'true');
    },
  );
});

describe('DeliverySlotPicker: keeping the shown chip in view', () => {
  const LEFTS: Record<string, number> = { '2026-10-31': 0, '2026-11-01': 100, '2026-11-03': 200 };

  function stubGeometry() {
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return LEFTS[this.getAttribute('data-date') ?? ''] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'tab' ? 90 : 0;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('role') === 'tablist' ? 150 : 0;
    });
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('role') === 'tablist' ? 300 : 0;
    });
  }

  it('scrolls the row (only the row) so the opening day is visible on the first render', () => {
    stubGeometry();
    const scroll = vi.spyOn(Element.prototype, 'scrollLeft', 'set');
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPicker({ selectedId: LATER });
    // 200 + 90 - 150 = 140: the chip's end is flush with the row's end.
    expect(scroll).toHaveBeenCalledWith(140);
    // The page itself is never asked to scroll.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls again when the day changes', () => {
    stubGeometry();
    const scroll = vi.spyOn(Element.prototype, 'scrollLeft', 'set');
    renderPicker();
    expect(scroll).not.toHaveBeenCalled(); // the first chip is already in view
    fireEvent.click(tab(/Seshanba/));
    expect(scroll).toHaveBeenCalledWith(140);
  });
});

describe('DeliverySlotPicker: localized (ru)', () => {
  it('names the days, weekdays, free counts, plurals and the full marker in Russian', () => {
    renderPicker({}, 'ru');
    expect(screen.getByRole('tablist', { name: 'День доставки' })).toBeInTheDocument();
    const [today, tomorrow, later] = tabs() as [HTMLElement, HTMLElement, HTMLElement];
    expect(today).toHaveTextContent('Сегодня31.10Свободно: 1');
    expect(tomorrow).toHaveTextContent('Завтра01.11Свободно: 1');
    expect(later).toHaveTextContent('Вторник03.11Свободно: 1');
    expect(screen.getByRole('radiogroup', { name: 'Время доставки' })).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'Сегодня, 31.10, 10:00–12:00' }),
    ).toHaveAccessibleDescription('Осталось 2 места');
    expect(
      screen.getByRole('radio', { name: 'Сегодня, 31.10, 12:00–14:00' }),
    ).toHaveAccessibleDescription('Мест нет');
  });

  it('announces the chosen day in Russian', () => {
    renderPicker({ selectedId: TODAY_LOW }, 'ru');
    expect(tab(/Сегодня/)).toHaveAccessibleName(
      'Сегодня, 31.10, Свободно: 1, здесь выбранное время',
    );
    fireEvent.click(tab(/Завтра/));
    expect(screen.getByTestId('slot-chosen-elsewhere')).toHaveTextContent(
      'Выбранное время: Сегодня, 31.10, 10:00–12:00',
    );
  });

  it('uses the right Russian plural for 1, 2 and 5 places', () => {
    renderPicker(
      {
        slots: [
          slotOption({ id: 'a', starts_at: '08:00', ends_at: '09:00', remaining: 1 }),
          slotOption({ id: 'b', starts_at: '09:00', ends_at: '10:00', remaining: 2 }),
          slotOption({ id: 'c', starts_at: '10:00', ends_at: '11:00', remaining: 3 }),
        ],
      },
      'ru',
    );
    const text = screen
      .getAllByTestId('delivery-slot-option')
      .map((element) => element.textContent);
    expect(text[0]).toContain('Осталось 1 место');
    expect(text[1]).toContain('Осталось 2 места');
    expect(text[2]).toContain('Осталось 3 места');
  });
});
