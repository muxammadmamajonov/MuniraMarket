import type { DistrictCode } from '@muniramarket/contracts';

/**
 * Turns Yandex geosearch toponyms (name + description, in Russian, Uzbek Latin or Uzbek
 * Cyrillic, depending on the map language) into one of the twelve Tashkent district codes.
 *
 * Matching is deliberately strict: a district counts only when the text names it *as a district*
 * ("Чиланзарский район", "Chilonzor tumani", "Чилонзор тумани"). A bare "Chilonzor" is also a
 * metro station, a bazaar and a residential massif, so it is never enough on its own.
 */

export type PlaceMatch =
  | { kind: 'district'; code: DistrictCode }
  /** Inside Tashkent city, but no toponym named the district. */
  | { kind: 'city' }
  /** The toponyms describe somewhere that is not Tashkent city. */
  | { kind: 'elsewhere' }
  /** Nothing usable came back. */
  | { kind: 'nothing' };

/** Lower case, `ё`→`е`, Uzbek Cyrillic letters folded, apostrophes unified, hyphens to spaces. */
export function normalizePlaceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/ғ/g, 'г')
    .replace(/қ/g, 'к')
    .replace(/ҳ/g, 'х')
    .replace(/ў/g, 'у')
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One pattern per district, over normalized text: the Russian adjective + "район" (with the
 * pre-2014/2016 names Yandex may still return), Uzbek Latin "<name> tumani", Uzbek Cyrillic
 * "<name> тумани".
 */
const DISTRICT_PATTERNS: ReadonlyArray<[DistrictCode, RegExp]> = [
  ['bektemir', /бектемирск\S* район|bektemir tuman|бектемир туман/],
  ['chilonzor', /чиланзарск\S* район|chilonzor tuman|чилонзор туман/],
  ['mirobod', /мирабадск\S* район|mirobod tuman|миробод туман/],
  ['mirzo_ulugbek', /мирзо улугбекск\S* район|mirzo ulug'?bek tuman|мирзо улугбек туман/],
  ['olmazor', /алмазарск\S* район|собир рахимовск\S* район|olmazor tuman|олмазор туман/],
  ['sergeli', /сергелийск\S* район|sergeli tuman|сергели туман/],
  ['shayxontohur', /шайхантахурск\S* район|shayxontohur tuman|шайхонтохур туман/],
  ['uchtepa', /учтепинск\S* район|акмал икрамовск\S* район|uchtepa tuman|учтепа туман/],
  ['yakkasaroy', /яккасарайск\S* район|yakkasaroy tuman|яккасарой туман/],
  ['yangihayot', /янгихаетск\S* район|yangihayot tuman|янгихает туман/],
  ['yashnobod', /яшнабадск\S* район|хамзинск\S* район|yashnobod tuman|яшнобод туман/],
  ['yunusobod', /юнусабадск\S* район|yunusobod tuman|юнусобод туман/],
];

export function districtInText(text: string): DistrictCode | null {
  const normalized = normalizePlaceText(text);
  for (const [code, pattern] of DISTRICT_PATTERNS) if (pattern.test(normalized)) return code;
  return null;
}

/**
 * Tashkent *city*: "Ташкент" / "Toshkent" / "Тошкент" as a word, but not the region around it
 * ("Ташкентская область", "Toshkent viloyati", "Toshkent tumani" is a district of the region).
 */
const CITY_PATTERN =
  /(^|[^a-zа-я'])(ташкент|toshkent|тошкент|tashkent)(?![a-zа-я'])(?! (viloyat|вилоят|tuman|тумани))/;

export function mentionsTashkentCity(text: string): boolean {
  return CITY_PATTERN.test(normalizePlaceText(text));
}

/**
 * Decides from geosearch results (closest first). The first toponym that names a district wins;
 * otherwise the city alone, otherwise "elsewhere" when results exist but none is in Tashkent.
 */
export function matchPlace(
  features: ReadonlyArray<{ properties: { name: string; description: string } }>,
): PlaceMatch {
  let city = false;
  let any = false;
  for (const feature of features) {
    const text = `${feature.properties.name}, ${feature.properties.description}`;
    if (text.replace(/[\s,]/g, '') === '') continue;
    any = true;
    const code = districtInText(text);
    if (code !== null) return { kind: 'district', code };
    if (mentionsTashkentCity(text)) city = true;
  }
  if (city) return { kind: 'city' };
  return any ? { kind: 'elsewhere' } : { kind: 'nothing' };
}
