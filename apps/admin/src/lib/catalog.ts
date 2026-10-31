import type {
  AdminCategory,
  AdminProduct,
  Locale,
  ProductCreateRequest,
  ProductUnit,
  ProductUpdateRequest,
} from '@muniramarket/contracts';
import { PRODUCT_UNITS } from '@muniramarket/contracts';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { parseIntegerField } from './numbers';
import { SKU_PATTERN, SLUG_PATTERN } from './slug';

export const MAX_PRICE = 1_000_000_000_000;
export const MAX_STOCK = 1_000_000;
export const MAX_SORT = 100_000;

/** The name of a catalog entity in the UI language. */
export function localName(item: { name_uz: string; name_ru: string }, locale: Locale): string {
  return locale === 'ru' ? item.name_ru : item.name_uz;
}

export interface CategoryRow {
  category: AdminCategory;
  depth: number;
}

/**
 * Categories as a depth-first tree (siblings by `sort_order`, then name), for the tree view and for
 * indented select options. Orphans (a parent that is not in the list) are shown as roots, and a
 * cycle can never loop forever.
 */
export function categoryTree(items: readonly AdminCategory[], locale: Locale): CategoryRow[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string | null, AdminCategory[]>();
  for (const item of items) {
    const parent = item.parent_id !== null && ids.has(item.parent_id) ? item.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const byOrder = (a: AdminCategory, b: AdminCategory) =>
    a.sort_order - b.sort_order || localName(a, locale).localeCompare(localName(b, locale), locale);

  const rows: CategoryRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const category of [...(children.get(parent) ?? [])].sort(byOrder)) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      rows.push({ category, depth });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Ids of a category and everything below it (a category cannot be moved under one of these). */
export function descendantIds(items: readonly AdminCategory[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (item.parent_id !== null && result.has(item.parent_id) && !result.has(item.id)) {
        result.add(item.id);
        grew = true;
      }
    }
  }
  return result;
}

/** `"  Fruits"`-style label so a native `<select>` shows the tree. */
export function indentedLabel(name: string, depth: number): string {
  return `${' '.repeat(depth)}${depth > 0 ? '↳ ' : ''}${name}`;
}

/** Mirrors `validate_image_url` of the API (the server stays the authority and never fetches it). */
export function isValidImageUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > 2048) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(raw) || !/^[\x20-\x7e]+$/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (host === '' || host === 'localhost' || /^\[.*\]$/.test(host)) return false;
  const labels = host.split('.');
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return false;
  }
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return false;
  return !/\.(local|internal|localhost|lan|home|corp)$/.test(host);
}

// -- Product form ------------------------------------------------------------------------------

export interface ProductFormValues {
  sku: string;
  slug: string;
  name_uz: string;
  name_ru: string;
  description_uz: string;
  description_ru: string;
  category_id: string;
  unit: ProductUnit | '';
  price: string;
  old_price: string;
  stock: string;
  sort_order: string;
  image_url: string;
  is_active: boolean;
}

export type FormProblems = Partial<Record<FieldKey, 'required' | 'invalid'>>;

export function emptyProductForm(): ProductFormValues {
  return {
    sku: '',
    slug: '',
    name_uz: '',
    name_ru: '',
    description_uz: '',
    description_ru: '',
    category_id: '',
    unit: 'piece',
    price: '',
    old_price: '',
    stock: '',
    sort_order: '0',
    image_url: '',
    is_active: true,
  };
}

export function productToForm(product: AdminProduct): ProductFormValues {
  return {
    sku: product.sku,
    slug: product.slug,
    name_uz: product.name_uz,
    name_ru: product.name_ru,
    description_uz: product.description_uz ?? '',
    description_ru: product.description_ru ?? '',
    category_id: product.category_id,
    unit: product.unit,
    price: String(product.price_uzs),
    old_price: product.old_price_uzs === null ? '' : String(product.old_price_uzs),
    stock: product.stock_quantity === null ? '' : String(product.stock_quantity),
    sort_order: String(product.sort_order),
    image_url: product.image_url ?? '',
    is_active: product.is_active,
  };
}

const singleLine = (value: string) => !/[\n\r\t\u0000-\u001f\u007f-\u009f]/.test(value);

/** Client-side check of the same rules the API enforces; the API's 422 is still mapped per field. */
export function validateProductForm(values: ProductFormValues): FormProblems {
  const problems: FormProblems = {};
  const name = (key: 'name_uz' | 'name_ru') => {
    const text = values[key].trim();
    if (text === '') problems[key] = 'required';
    else if (text.length > 255 || !singleLine(text)) problems[key] = 'invalid';
  };
  name('name_uz');
  name('name_ru');

  if (values.sku.trim() === '') problems.sku = 'required';
  else if (!SKU_PATTERN.test(values.sku.trim())) problems.sku = 'invalid';

  if (values.slug.trim() === '') problems.slug = 'required';
  else if (!SLUG_PATTERN.test(values.slug.trim()) || values.slug.trim().length > 128) {
    problems.slug = 'invalid';
  }

  if (values.category_id === '') problems.category_id = 'required';
  if (values.unit === '' || !PRODUCT_UNITS.includes(values.unit)) problems.unit = 'required';

  const price = parseIntegerField(values.price, { min: 0, max: MAX_PRICE });
  if (price === null) problems.price_uzs = 'required';
  else if (price === 'invalid') problems.price_uzs = 'invalid';

  const oldPrice = parseIntegerField(values.old_price, { min: 0, max: MAX_PRICE });
  if (oldPrice === 'invalid') problems.old_price_uzs = 'invalid';
  else if (oldPrice !== null && typeof price === 'number' && oldPrice <= price) {
    problems.old_price_uzs = 'invalid';
  }

  if (parseIntegerField(values.stock, { min: 0, max: MAX_STOCK }) === 'invalid') {
    problems.stock_quantity = 'invalid';
  }
  const sort = parseIntegerField(values.sort_order, { min: -MAX_SORT, max: MAX_SORT });
  if (sort === 'invalid' || sort === null)
    problems.sort_order = sort === null ? 'required' : 'invalid';

  if (values.image_url.trim() !== '' && !isValidImageUrl(values.image_url.trim())) {
    problems.image_url = 'invalid';
  }
  for (const key of ['description_uz', 'description_ru'] as const) {
    if (values[key].length > 5000) problems[key] = 'invalid';
  }
  return problems;
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());
const intOrNull = (text: string, min: number, max: number): number | null => {
  const parsed = parseIntegerField(text, { min, max });
  return typeof parsed === 'number' ? parsed : null;
};

/** The body of `POST /admin/products`. Call only after `validateProductForm` found nothing. */
export function buildCreateRequest(values: ProductFormValues): ProductCreateRequest {
  return {
    sku: values.sku.trim(),
    slug: values.slug.trim(),
    name_uz: values.name_uz.trim(),
    name_ru: values.name_ru.trim(),
    description_uz: orNull(values.description_uz),
    description_ru: orNull(values.description_ru),
    category_id: values.category_id,
    unit: values.unit as ProductUnit,
    price_uzs: intOrNull(values.price, 0, MAX_PRICE) ?? 0,
    old_price_uzs: intOrNull(values.old_price, 0, MAX_PRICE),
    stock_quantity: intOrNull(values.stock, 0, MAX_STOCK),
    is_active: values.is_active,
    sort_order: intOrNull(values.sort_order, -MAX_SORT, MAX_SORT) ?? 0,
    image_url: orNull(values.image_url),
  };
}

/**
 * The body of `PATCH /admin/products/{id}`: only the fields that differ from the loaded product,
 * because the API changes exactly the fields it receives (and an empty body is an error).
 */
export function buildUpdateRequest(
  values: ProductFormValues,
  original: AdminProduct,
): ProductUpdateRequest {
  const next = buildCreateRequest(values);
  const changes: ProductUpdateRequest = {};
  const keys = Object.keys(next) as Array<keyof ProductCreateRequest>;
  for (const key of keys) {
    const current = next[key] as unknown;
    const before = (original as unknown as Record<string, unknown>)[key];
    const normalizedBefore =
      key === 'description_uz' || key === 'description_ru' ? orNull(String(before ?? '')) : before;
    if (current !== normalizedBefore) (changes as Record<string, unknown>)[key] = current;
  }
  return changes;
}
