import { DISTRICT_CODES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { toponym } from '@/lib/maps/test-helpers';
import { DISTRICT_LABELS } from './districts';
import { districtInText, matchPlace, mentionsTashkentCity } from './district-match';

describe('districtInText', () => {
  it.each([
    ['Чиланзарский район', 'chilonzor'],
    ['Мирзо-Улугбекский район, Ташкент', 'mirzo_ulugbek'],
    ['Яшнабадский район', 'yashnobod'],
    ['Хамзинский район', 'yashnobod'],
    ['Янгихаётский район', 'yangihayot'],
    ['Шайхантахурский район', 'shayxontohur'],
    ['Chilonzor tumani, Toshkent', 'chilonzor'],
    ['Mirzo Ulug‘bek tumani', 'mirzo_ulugbek'],
    ["Mirzo Ulug'bek tumani", 'mirzo_ulugbek'],
    ['Yangihayot tumani', 'yangihayot'],
    ['Юнусобод тумани', 'yunusobod'],
    ['Мирзо Улуғбек тумани', 'mirzo_ulugbek'],
    ['Шайхонтоҳур тумани', 'shayxontohur'],
  ] as const)('%s → %s', (text, code) => {
    expect(districtInText(text)).toBe(code);
  });

  it.each([
    'Чиланзар',
    'метро Чиланзар',
    'Chilonzor bozori',
    'Yunusobod metro bekati',
    'улица Мирабад',
    'Ташкентский район',
  ])('a bare place name is not a district (%s)', (text) => {
    expect(districtInText(text)).toBeNull();
  });

  it('recognises every district in Russian and Uzbek', () => {
    for (const code of DISTRICT_CODES) {
      expect(districtInText(`${DISTRICT_LABELS[code].ru} район`)).toBe(code);
      expect(districtInText(`${DISTRICT_LABELS[code].uz} tumani`)).toBe(code);
    }
  });
});

describe('mentionsTashkentCity', () => {
  it.each(['Ташкент, Узбекистан', 'Toshkent, O‘zbekiston', 'Тошкент шаҳри', 'Tashkent'])(
    'city: %s',
    (text) => expect(mentionsTashkentCity(text)).toBe(true),
  );

  it.each([
    'Ташкентская область, Узбекистан',
    'Toshkent viloyati',
    'Toshkent tumani',
    'Ташкентский район',
    'Самарканд, Узбекистан',
  ])('not the city: %s', (text) => expect(mentionsTashkentCity(text)).toBe(false));
});

describe('matchPlace', () => {
  it('takes the first toponym that names a district', () => {
    expect(
      matchPlace([
        toponym('улица Бунёдкор, 15', 'Ташкент, Узбекистан'),
        toponym('Чиланзарский район', 'Ташкент, Узбекистан'),
        toponym('Ташкент', 'Узбекистан'),
      ]),
    ).toEqual({ kind: 'district', code: 'chilonzor' });
  });

  it('knows the city without a district', () => {
    expect(matchPlace([toponym('улица Навои', 'Ташкент, Узбекистан')])).toEqual({ kind: 'city' });
  });

  it('says elsewhere for results outside the city', () => {
    expect(
      matchPlace([
        toponym('Чирчик', 'Ташкентская область, Узбекистан'),
        toponym('Ташкентская область', 'Узбекистан'),
      ]),
    ).toEqual({ kind: 'elsewhere' });
  });

  it('says nothing for no results', () => {
    expect(matchPlace([])).toEqual({ kind: 'nothing' });
    expect(matchPlace([toponym('', '')])).toEqual({ kind: 'nothing' });
  });
});
