/**
 * Response bodies with the reference's exact field order, names and nulls (ports of the
 * `from_record` builders in services/api/app/schemas/{catalog,cart,checkout}.py).
 */
import { evaluateCart, isInStock, type CartIssue } from '../../domain/cart.ts';
import type { QuoteIssue } from '../../domain/checkout.ts';
import {
  allowedTransitionsOf,
  customerCanCancel,
  type OrderStatus,
} from '../../domain/orderStatus.ts';
import type { UserRole } from '../../http/context.ts';
import type { SavedAddressRecord } from '../../repositories/addresses.ts';
import type { CartLineRecord, CartRecord } from '../../repositories/cart.ts';
import type {
  CategoryNodeRecord,
  ProductDetailRecord,
  ProductPageRecord,
  ProductSummaryRecord,
  Unit,
} from '../../repositories/catalog.ts';
import {
  coordinatesOf,
  type OrderPageRecord,
  type OrderRecord,
  type PaymentMethod,
  type QuoteRecord,
} from '../../repositories/orders.ts';

// --- catalog -------------------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
  image_url: string | null;
  sort_order: number;
  children: CategoryNode[];
}

export function categoryNode(record: CategoryNodeRecord): CategoryNode {
  return {
    id: record.id,
    slug: record.slug,
    name_uz: record.name_uz,
    name_ru: record.name_ru,
    image_url: record.image_url,
    sort_order: record.sort_order,
    children: record.children.map(categoryNode),
  };
}

export interface ProductSummary {
  id: string;
  slug: string;
  sku: string;
  name_uz: string;
  name_ru: string;
  unit: Unit;
  price_uzs: number;
  old_price_uzs: number | null;
  /** `null` = stock is not tracked for this product. */
  stock_quantity: number | null;
  in_stock: boolean;
  image_url: string | null;
  category_id: string;
}

export function productSummary(record: ProductSummaryRecord): ProductSummary {
  return {
    id: record.id,
    slug: record.slug,
    sku: record.sku,
    name_uz: record.name_uz,
    name_ru: record.name_ru,
    unit: record.unit,
    price_uzs: record.price_uzs,
    old_price_uzs: record.old_price_uzs,
    stock_quantity: record.stock_quantity,
    in_stock: isInStock(record.stock_quantity),
    image_url: record.image_url,
    category_id: record.category_id,
  };
}

export function productDetail(record: ProductDetailRecord) {
  return {
    ...productSummary(record.summary),
    description_uz: record.description_uz,
    description_ru: record.description_ru,
    brand: record.brand,
    category: {
      id: record.category.id,
      slug: record.category.slug,
      name_uz: record.category.name_uz,
      name_ru: record.category.name_ru,
    },
  };
}

export function productPage(
  record: ProductPageRecord,
  page: number,
  pageSize: number,
  totalPages: number,
) {
  return {
    items: record.items.map(productSummary),
    page,
    page_size: pageSize,
    total: record.total,
    total_pages: totalPages,
  };
}

// --- cart ----------------------------------------------------------------------------------------

export interface CartLine {
  product: ProductSummary;
  quantity: number;
  /** Always price x quantity; lines with an `issue` are left out of the cart totals. */
  line_total_uzs: number;
  issue: CartIssue | null;
}

function cartLines(
  lines: readonly CartLineRecord[],
  evaluated: readonly { issue: CartIssue | null; lineTotalUzs: number }[],
): CartLine[] {
  return lines.map((line, index) => {
    const result = evaluated[index];
    if (result === undefined) throw new Error('evaluated line missing');
    return {
      product: productSummary(line.product),
      quantity: line.quantity,
      line_total_uzs: result.lineTotalUzs,
      issue: result.issue,
    };
  });
}

export function cartBody(record: CartRecord) {
  const { lines, totals } = evaluateCart(
    record.lines.map((line) => ({
      priceUzs: line.product.price_uzs,
      quantity: line.quantity,
      isAvailable: line.isAvailable,
      stockQuantity: line.product.stock_quantity,
    })),
  );
  return {
    items: cartLines(record.lines, lines),
    item_count: totals.itemCount,
    subtotal_uzs: totals.subtotalUzs,
    total_uzs: totals.totalUzs,
    has_issues: totals.hasIssues,
  };
}

// --- checkout / orders ---------------------------------------------------------------------------

export function checkoutQuote(record: QuoteRecord) {
  const totals = record.totals;
  return {
    items: cartLines(record.lines, totals.lines),
    item_count: totals.cart.itemCount,
    subtotal_uzs: totals.subtotalUzs,
    total_uzs: totals.totalUzs,
    issues: [...totals.issues] as QuoteIssue[],
    can_place_order: totals.canPlaceOrder,
  };
}

/**
 * The stored address snapshot. `lat`/`lon` are `null` only for orders placed before addresses
 * had coordinates; any other key of an old snapshot is ignored.
 */
function orderAddress(snapshot: Record<string, unknown>) {
  const optional = (key: string): string | null => {
    const value = snapshot[key];
    return typeof value === 'string' ? value : null;
  };
  const point = coordinatesOf(snapshot);
  return {
    lat: point?.lat ?? null,
    lon: point?.lon ?? null,
    street: snapshot['street'] as string,
    house: snapshot['house'] as string,
    apartment: optional('apartment'),
    entrance: optional('entrance'),
    floor: optional('floor'),
    landmark: optional('landmark'),
  };
}

export function orderDetail(record: OrderRecord) {
  return {
    id: record.id,
    number: record.number,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    subtotal_uzs: record.subtotal_uzs,
    total_uzs: record.total_uzs,
    item_count: record.item_count,
    payment_method: record.payment_method as PaymentMethod,
    recipient_name: record.recipient_name,
    recipient_phone: record.recipient_phone,
    address: orderAddress(record.address),
    comment: record.comment,
    cancel_reason: record.cancel_reason,
    items: record.items.map((item) => ({
      product_id: item.product_id,
      sku: item.sku,
      name_uz: item.name_uz,
      name_ru: item.name_ru,
      unit: item.unit,
      unit_price_uzs: item.unit_price_uzs,
      quantity: item.quantity,
      line_total_uzs: item.line_total_uzs,
    })),
    history: record.history.map((change) => ({ status: change.to_status, at: change.created_at })),
    can_cancel: customerCanCancel(record.status),
  };
}

export function adminOrderDetail(record: OrderRecord) {
  return {
    ...orderDetail(record),
    history_detail: record.history.map((change) => ({
      from_status: change.from_status as OrderStatus | null,
      status: change.to_status,
      actor_role: change.actor_role as UserRole,
      reason: change.reason,
      at: change.created_at,
    })),
    // Statuses this order may move to next (CANCELLED needs a reason).
    allowed_transitions: allowedTransitionsOf(record.status),
  };
}

export function orderPage(record: OrderPageRecord, page: number, pageSize: number) {
  return {
    items: record.items.map((item) => ({
      id: item.id,
      number: item.number,
      status: item.status,
      total_uzs: item.total_uzs,
      item_count: item.item_count,
      created_at: item.created_at,
      thumbnails: item.thumbnails.map((thumbnail) => ({
        product_id: thumbnail.product_id,
        name_uz: thumbnail.name_uz,
        name_ru: thumbnail.name_ru,
        image_url: thumbnail.image_url,
      })),
    })),
    page,
    page_size: pageSize,
    total: record.total,
    total_pages: Math.ceil(record.total / pageSize),
  };
}

// --- saved addresses -----------------------------------------------------------------------------

export function savedAddress(record: SavedAddressRecord) {
  return {
    id: record.id,
    label: record.label,
    lat: record.lat,
    lon: record.lon,
    street: record.street,
    house: record.house,
    apartment: record.apartment,
    entrance: record.entrance,
    floor: record.floor,
    landmark: record.landmark,
    is_default: record.is_default,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
