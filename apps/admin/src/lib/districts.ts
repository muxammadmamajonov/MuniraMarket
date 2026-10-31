import type { DistrictCode, Locale } from '@muniramarket/contracts';

/**
 * The twelve districts (tumanlar) of Tashkent, as the API knows them (`DISTRICT_NAMES` in
 * `services/api/app/domain/delivery.py`). The admin API only lists districts that already belong to
 * a zone, so the full list a zone can choose from is fixed here; the `Record` type makes a district
 * added to the contract a compile error until it is named.
 */
const NAMES: Record<DistrictCode, Record<Locale, string>> = {
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

export const DISTRICT_CODES = Object.keys(NAMES) as DistrictCode[];

/** Name of a district in `locale`; an unknown code is shown as is. */
export function districtName(code: string, locale: Locale): string {
  return (NAMES as Record<string, Record<Locale, string> | undefined>)[code]?.[locale] ?? code;
}
