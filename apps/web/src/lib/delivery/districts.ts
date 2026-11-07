import type { DistrictCode, Locale } from '@muniramarket/contracts';

/**
 * Public facts about the twelve districts of Tashkent city, for the map's delivery check: their
 * display names (used when a district is not in any active zone, so the API does not return it)
 * and which districts border which (for "we don't deliver there yet, try a neighbour").
 *
 * The names mirror `DISTRICT_NAMES` in the Core API (`services/core-api-function/src/domain/
 * delivery.ts`). The neighbour lists are approximate public geography, used only to suggest
 * alternatives; they never decide whether we deliver somewhere (only the zones API does).
 */

export const DISTRICT_LABELS: Readonly<Record<DistrictCode, { uz: string; ru: string }>> = {
  bektemir: { uz: 'Bektemir', ru: 'Бектемирский' },
  chilonzor: { uz: 'Chilonzor', ru: 'Чиланзарский' },
  mirobod: { uz: 'Mirobod', ru: 'Мирабадский' },
  mirzo_ulugbek: { uz: 'Mirzo Ulug‘bek', ru: 'Мирзо-Улугбекский' },
  olmazor: { uz: 'Olmazor', ru: 'Алмазарский' },
  sergeli: { uz: 'Sergeli', ru: 'Сергелийский' },
  shayxontohur: { uz: 'Shayxontohur', ru: 'Шайхантахурский' },
  uchtepa: { uz: 'Uchtepa', ru: 'Учтепинский' },
  yakkasaroy: { uz: 'Yakkasaroy', ru: 'Яккасарайский' },
  yangihayot: { uz: 'Yangihayot', ru: 'Янгихаётский' },
  yashnobod: { uz: 'Yashnobod', ru: 'Яшнабадский' },
  yunusobod: { uz: 'Yunusobod', ru: 'Юнусабадский' },
};

export function districtLabel(code: DistrictCode, locale: Locale): string {
  return DISTRICT_LABELS[code][locale];
}

/** Bordering districts, nearest-feeling first. Approximate; suggestions only. */
export const DISTRICT_NEIGHBOURS: Readonly<Record<DistrictCode, readonly DistrictCode[]>> = {
  bektemir: ['yashnobod', 'sergeli', 'mirobod'],
  chilonzor: ['yakkasaroy', 'uchtepa', 'sergeli', 'yangihayot', 'shayxontohur', 'olmazor'],
  mirobod: ['yakkasaroy', 'yashnobod', 'mirzo_ulugbek', 'shayxontohur', 'yunusobod', 'sergeli'],
  mirzo_ulugbek: ['yunusobod', 'yashnobod', 'mirobod'],
  olmazor: ['shayxontohur', 'uchtepa', 'yunusobod', 'chilonzor'],
  sergeli: ['yangihayot', 'chilonzor', 'yakkasaroy', 'mirobod', 'bektemir'],
  shayxontohur: ['olmazor', 'yunusobod', 'mirobod', 'yakkasaroy', 'chilonzor', 'uchtepa'],
  uchtepa: ['chilonzor', 'olmazor', 'shayxontohur', 'yangihayot'],
  yakkasaroy: ['mirobod', 'shayxontohur', 'chilonzor', 'sergeli'],
  yangihayot: ['sergeli', 'chilonzor', 'uchtepa'],
  yashnobod: ['mirzo_ulugbek', 'mirobod', 'bektemir'],
  yunusobod: ['mirzo_ulugbek', 'olmazor', 'shayxontohur', 'mirobod'],
};
