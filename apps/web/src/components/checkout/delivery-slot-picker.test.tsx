import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { slotOption, slotQuote } from '@/lib/checkout/test-fixtures';
import { DeliverySlotPicker, type DeliverySlotPickerProps } from './delivery-slot-picker';

const TODAY = '2026-10-31';
const IDS = ['1', '2', '3', '4'].map((n) => `5a000000-0000-4000-8000-00000000000${n}`);

function renderPicker(props: Partial<DeliverySlotPickerProps> = {}, locale: 'uz' | 'ru' = 'uz') {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const view = render(
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
      />
    </LocaleProvider>,
  );
  return { ...view, onSelect, onClear };
}

const group = () => screen.getByRole('radiogroup', { name: 'Yetkazish vaqti' });
const option = (id: string) =>
  screen
    .getAllByTestId('delivery-slot-option')
    .find((element) => element.getAttribute('data-slot-id') === id) as HTMLElement;

describe('DeliverySlotPicker', () => {
  it('is one radio group labelled "delivery time", with a native radio per window', () => {
    renderPicker();
    const radios = within(group()).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    // One shared name makes the browser's own arrow-key navigation and "one selected" work.
    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(
      new Set(['deliverySlot']),
    );
    expect(group()).toHaveAttribute('aria-required', 'true');
    expect(group()).toHaveAccessibleDescription('Buyurtma berish uchun yetkazish vaqtini tanlang.');
  });

  it('groups windows by day: today and tomorrow by word, later days by weekday, with the date', () => {
    const { container } = renderPicker();
    const days = [...container.querySelectorAll('[data-day]')];
    expect(days.map((day) => day.getAttribute('data-day'))).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-03',
    ]);
    expect(days[0]).toHaveTextContent('Bugun31.10');
    expect(days[1]).toHaveTextContent('Ertaga01.11');
    expect(days[2]).toHaveTextContent('Seshanba03.11');
    expect(within(days[0] as HTMLElement).getAllByTestId('delivery-slot-option')).toHaveLength(2);
  });

  it('writes each window as HH:MM–HH:MM and names every radio with its day', () => {
    renderPicker();
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Seshanba, 03.11, 16:00–18:00' })).toBeInTheDocument();
  });

  it('exposes stable test hooks on every option', () => {
    renderPicker();
    const options = screen.getAllByTestId('delivery-slot-option');
    expect(options.map((element) => element.getAttribute('data-slot-id'))).toEqual(IDS);
  });

  it('calls out a nearly full window, and says nothing about a comfortable one', () => {
    renderPicker();
    const low = screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' });
    expect(low).toHaveAccessibleDescription('2 ta joy qoldi');
    const roomy = screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' });
    expect(roomy).not.toHaveAccessibleDescription();
    expect(option(IDS[2] as string)).not.toHaveTextContent('joy');
  });

  it('keeps a full window visible but disabled, struck through and labelled', () => {
    const { onSelect } = renderPicker();
    const full = screen.getByRole('radio', { name: 'Bugun, 31.10, 12:00–14:00' });
    expect(full).toBeDisabled();
    expect(full).toHaveAccessibleDescription('To‘lgan');
    expect(option(IDS[1] as string)).toHaveAttribute('data-full', 'true');
    expect(option(IDS[1] as string)).toHaveTextContent('To‘lgan');
    fireEvent.click(option(IDS[1] as string));
    expect(onSelect).not.toHaveBeenCalled();
    expect(full).not.toBeChecked();
  });

  it('treats a window with no places as full even when the server did not flag it', () => {
    renderPicker({ slots: [slotOption({ id: 'x', remaining: 0, is_full: false })] });
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('selects a window by tapping it, and shows the chosen one as checked', () => {
    const { onSelect, rerender } = renderPicker();
    fireEvent.click(option(IDS[2] as string));
    expect(onSelect).toHaveBeenCalledWith(IDS[2]);

    rerender(
      <LocaleProvider locale="uz">
        <DeliverySlotPicker
          slots={slotQuote().delivery_slots}
          selectedId={IDS[2] as string}
          required
          disabled={false}
          stale={false}
          notice={null}
          onSelect={onSelect}
          onClear={vi.fn()}
          today={TODAY}
        />
      </LocaleProvider>,
    );
    expect(screen.getByRole('radio', { name: 'Ertaga, 01.11, 10:00–12:00' })).toBeChecked();
    expect(
      screen.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
  });

  it('lays tiles out in as many columns as fit (two at 360px, one never overflows) with 56px targets', () => {
    const { container } = renderPicker();
    expect(option(IDS[0] as string).className).toContain('min-h-14');
    // `auto-fill` with a minimum that fits an "HH:MM–HH:MM" time: no fixed column count that would
    // overflow at 200% zoom or 320px.
    expect(container.querySelector('[data-day] > div')?.className).toContain(
      'grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]',
    );
    // Controls are not text to select, and respond to a tap without the double-tap delay.
    expect(option(IDS[0] as string).className).toContain('select-none');
    expect(option(IDS[0] as string).className).toContain('touch-manipulation');
    // Press feedback, only while the window can be chosen; reduced motion is handled globally.
    expect(option(IDS[0] as string).className).toContain('active:scale-[0.97]');
    expect(option(IDS[1] as string).className).not.toContain('active:scale');
  });

  it('renders no empty radio group when there are no windows at all', () => {
    renderPicker({ slots: [] });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByTestId('slots-none')).toBeInTheDocument();
  });

  it('is localized (ru): day words, weekdays, plurals and the full marker', () => {
    const { container } = renderPicker({}, 'ru');
    const days = [...container.querySelectorAll('[data-day]')];
    expect(days[0]).toHaveTextContent('Сегодня31.10');
    expect(days[1]).toHaveTextContent('Завтра01.11');
    expect(days[2]).toHaveTextContent('Вторник03.11');
    expect(screen.getByRole('radiogroup', { name: 'Время доставки' })).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'Сегодня, 31.10, 10:00–12:00' }),
    ).toHaveAccessibleDescription('Осталось 2 места');
    expect(
      screen.getByRole('radio', { name: 'Сегодня, 31.10, 12:00–14:00' }),
    ).toHaveAccessibleDescription('Мест нет');
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

  it.each([
    ['full', 'Bu vaqt oralig‘i to‘lib qoldi. Boshqa vaqtni tanlang.'],
    ['unavailable', 'Bu vaqt endi mavjud emas. Boshqa vaqtni tanlang.'],
    ['required', 'Buyurtma berish uchun yetkazish vaqtini tanlang.'],
  ] as const)(
    'shows the "%s" notice next to the choices and marks the group invalid',
    (reason, text) => {
      renderPicker({ notice: reason });
      const notice = screen.getByTestId('slot-notice');
      expect(notice).toHaveAttribute('role', 'alert');
      expect(notice).toHaveTextContent(text);
      expect(group()).toHaveAttribute('aria-invalid', 'true');
      expect(group()).toHaveAccessibleDescription(expect.stringContaining(text));
    },
  );

  it('dims and disables the choices while the windows are being refreshed', () => {
    renderPicker({ stale: true, selectedId: IDS[0] as string });
    expect(screen.getByTestId('delivery-slots')).toHaveAttribute('aria-busy', 'true');
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(group().className).toContain('opacity-60');
    // The choice itself stays visible.
    expect(screen.getByRole('radio', { name: 'Bugun, 31.10, 10:00–12:00' })).toBeChecked();
  });

  it('disables the choices while the order is being sent', () => {
    renderPicker({ disabled: true });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('says so when every window is taken', () => {
    renderPicker({
      slots: [slotOption({ id: 'x', is_full: true, remaining: 0 })],
    });
    expect(screen.getByTestId('slots-none')).toHaveTextContent('Hozircha bo‘sh vaqt qolmagan');
  });

  it('offers a way to clear the choice only when a window is optional', () => {
    const { onClear, rerender } = renderPicker({ required: false, selectedId: IDS[0] as string });
    expect(group()).not.toHaveAttribute('aria-required');
    expect(screen.getByText('Xohlasangiz, qulay yetkazish vaqtini tanlang.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('slot-clear'));
    expect(onClear).toHaveBeenCalledOnce();

    rerender(
      <LocaleProvider locale="uz">
        <DeliverySlotPicker
          slots={slotQuote().delivery_slots}
          selectedId={IDS[0] as string}
          required
          disabled={false}
          stale={false}
          notice={null}
          onSelect={vi.fn()}
          onClear={onClear}
          today={TODAY}
        />
      </LocaleProvider>,
    );
    expect(screen.queryByTestId('slot-clear')).toBeNull();
  });
});
