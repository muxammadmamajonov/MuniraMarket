/** Slug rule shared by categories, products and zones (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Suggests a slug from a SKU (`MILK_1.5L` -> `milk-1-5l`). May be empty or too long; the form validates. */
export function slugFromSku(sku: string): string {
  return sku
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
    .replace(/-+$/g, '');
}
