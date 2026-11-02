import type { DeliveryZone } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { zone } from '@/lib/checkout/test-fixtures';
import {
  DISTRICT_STORAGE_ITEM,
  resetDistrictPreferenceMemory,
} from '@/lib/delivery/district-preference';
import { TelegramProvider } from '@/lib/telegram';
import { DeliveryDistrict } from './delivery-district';

const ZONES: DeliveryZone[] = [
  zone(),
  zone({
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'demo-chekka',
    name_uz: 'Demo chekka zona',
    name_ru: 'Демо окраинная зона',
    delivery_fee_uzs: 25000,
    free_delivery_threshold_uzs: null,
    opens_at: '09:00',
    closes_at: '20:00',
    districts: [{ code: 'chilonzor', name_uz: 'Chilonzor', name_ru: 'Чиланзар' }],
  }),
];

function renderChooser(zones: DeliveryZone[] | null = ZONES, locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <button>before</button>
        <DeliveryDistrict zones={zones} />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  resetDistrictPreferenceMemory();
  document.body.style.overflow = '';
});

describe('DeliveryDistrict', () => {
  it('explains why the district matters before one is chosen, without claiming a location', () => {
    renderChooser();
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unset');
    expect(card).toHaveTextContent(
      'Yetkazish narxi va vaqt oralig‘lari tanlangan tumanga bog‘liq.',
    );
    expect(card.textContent).not.toMatch(/aniqlandi|определ|detected/i);
    expect(screen.getByRole('button', { name: 'Tumanni tanlash' })).toBeVisible();
  });

  it('opens a sheet, selects a district, and shows a summary backed by the zone data', () => {
    renderChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Tumanni tanlash' }));
    const dialog = screen.getByRole('dialog', { name: 'Yetkazish tumanini tanlang' });
    expect(within(dialog).getByRole('group', { name: /Demo markaziy zona/ })).toBeVisible();

    // Nothing is chosen yet, so "Tanlash" waits for a pick.
    const confirm = within(dialog).getByRole('button', { name: 'Tanlash' });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Yunusobod' }));
    fireEvent.click(confirm);

    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('yunusobod');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'set');
    expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Yunusobod');
    expect(card).toHaveTextContent('Yetkazish: 15 000 so‘m');
    expect(card).toHaveTextContent('300 000 so‘m dan bepul');
    expect(card).toHaveTextContent('Yetkazish vaqti: 09:00–21:00');
    expect(screen.getByText('Tanlangan tuman: Yunusobod')).toBeInTheDocument();
  });

  it('omits the free-delivery line when the zone has no threshold', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'chilonzor');
    renderChooser(ZONES, 'ru');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveTextContent('Чиланзар');
    expect(card).toHaveTextContent('Доставка: 25 000 сум');
    expect(card.textContent).not.toMatch(/Бесплатно/);
    expect(
      screen.getByRole('button', { name: 'Изменить: Район доставки, Чиланзар' }),
    ).toBeVisible();
  });

  it('changes the district, and closing without confirming keeps the old one', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'mirobod');
    renderChooser();
    const change = screen.getByRole('button', { name: /O‘zgartirish/ });

    fireEvent.click(change);
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Chilonzor' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('mirobod');

    act(() => {
      fireEvent.click(change);
    });
    dialog = screen.getAllByRole('dialog').at(-1) as HTMLElement;
    // Reopening starts again from the saved choice.
    expect(within(dialog).getByRole('radio', { name: 'Mirobod' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Chilonzor' }));
    fireEvent.submit(within(dialog).getByTestId('district-sheet'));
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('chilonzor');
    expect(screen.getByTestId('delivery-district-name')).toHaveTextContent('Chilonzor');
  });

  it('falls back to the prompt when the remembered district is no longer served', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'bektemir');
    renderChooser();
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unset');
    expect(card).toHaveTextContent('Avval tanlangan tumanga hozir yetkazilmaydi.');
  });

  it('ignores a tampered stored value', () => {
    window.localStorage.setItem(DISTRICT_STORAGE_ITEM, '<img src=x>');
    renderChooser();
    expect(screen.getByTestId('delivery-district')).toHaveAttribute('data-state', 'unset');
  });

  it('keeps browsing possible when zones could not be loaded', () => {
    renderChooser(null, 'ru');
    const card = screen.getByTestId('delivery-district');
    expect(card).toHaveAttribute('data-state', 'unavailable');
    expect(card).toHaveTextContent('Не удалось загрузить районы доставки.');
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('says so when no zone delivers', () => {
    renderChooser([]);
    expect(screen.getByTestId('delivery-district')).toHaveAttribute('data-state', 'no-zones');
  });
});
