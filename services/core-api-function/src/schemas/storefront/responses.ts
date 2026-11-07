/**
 * Response bodies with the reference's exact field order, names and nulls (ports of the
 * `from_record` builders in services/api/app/schemas/{catalog,cart,delivery,checkout}.py).
 */
import { evaluateCart, isInStock, type CartIssue } from '../../domain/cart.ts';
import type { QuoteIssue } from '../../domain/checkout.ts';
import {
  DISTRICT_CODES,
  DISTRICT_NAMES,
  TASHKENT_TIMEZONE,
  hhmm,
  isDistrictCode,
  isOpenAt,
} from '../../domain/delivery.ts';
import {
  allowedTransitionsOf,
  customerCanCancel,
  type OrderStatus,
} from '../../domain/orderStatus.ts';
import type { UserRole } from '../../http/context.ts';
import type { CartLineRecord, CartRecord } from '../../repositories/cart.ts';
import type {
  CategoryNodeRecord,
  ProductDetailRecord,
  ProductPageRecord,
  ProductSummaryRecord,
  Unit,
} from '../../repositories/catalog.ts';
import {
  slotRemaining,
  type SlotOptionRecord,
  type ZoneRecord,
} from '../../repositories/delivery.ts';
import type {
  OrderPageRecord,
  OrderRecord,
  PaymentMethod,
  QuoteRecord,
  SlotSnapshotRecord,
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

// --- delivery ------------------------------------------------------------------------------------

export function deliveryZone(zone: ZoneRecord, now: number) {
  return {
    id: zone.zoneId,
    slug: zone.slug,
    name_uz: zone.nameUz,
    name_ru: zone.nameRu,
    delivery_fee_uzs: zone.rules.deliveryFeeUzs,
    free_delivery_threshold_uzs: zone.rules.freeDeliveryThresholdUzs,
    min_order_uzs: zone.rules.minOrderUzs,
    opens_at: hhmm(zone.rules.opensAt),
    closes_at: hhmm(zone.rules.closesAt),
    is_open_now: isOpenAt(zone.rules, now),
    // Stable, documented order.
    districts: DISTRICT_CODES.filter((code) => zone.districts.has(code)).map((code) => ({
      code,
      name_uz: DISTRICT_NAMES[code].uz,
      name_ru: DISTRICT_NAMES[code].ru,
    })),
  };
}

export function deliveryZoneList(zones: readonly ZoneRecord[], now: number) {
  return { items: zones.map((zone) => deliveryZone(zone, now)), timezone: TASHKENT_TIMEZONE };
}

export function deliverySlotOption(slot: SlotOptionRecord) {
  const remaining = slotRemaining(slot);
  return {
    id: slot.id,
    date: slot.slotDate,
    starts_at: hhmm(slot.startsAt),
    ends_at: hhmm(slot.endsAt),
    remaining,
    is_full: remaining === 0,
  };
}

// --- checkout / orders ---------------------------------------------------------------------------

export function checkoutQuote(record: QuoteRecord, now: number) {
  const totals = record.totals;
  return {
    items: cartLines(record.lines, totals.lines),
    item_count: totals.cart.itemCount,
    subtotal_uzs: totals.subtotalUzs,
    delivery_fee_uzs: totals.deliveryFeeUzs,
    total_uzs: totals.totalUzs,
    free_delivery_remaining_uzs: totals.freeDeliveryRemainingUzs,
    zone: deliveryZone(record.zone, now),
    issues: [...totals.issues] as QuoteIssue[],
    can_place_order: totals.canPlaceOrder,
    slot_required: record.slotRequired,
    delivery_slots: record.slots.map(deliverySlotOption),
  };
}

function orderAddress(snapshot: Record<string, unknown>) {
  const district = snapshot['district'];
  if (typeof district !== 'string' || !isDistrictCode(district)) {
    throw new Error('unknown district in order snapshot');
  }
  const optional = (key: string): string | null => {
    const value = snapshot[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    district,
    district_name_uz: DISTRICT_NAMES[district].uz,
    district_name_ru: DISTRICT_NAMES[district].ru,
    street: snapshot['street'] as string,
    house: snapshot['house'] as string,
    apartment: optional('apartment'),
    entrance: optional('entrance'),
    floor: optional('floor'),
    landmark: optional('landmark'),
  };
}

function orderDeliverySlot(record: SlotSnapshotRecord | null) {
  if (record === null) return null;
  return {
    date: record.slot_date,
    starts_at: hhmm(record.starts_at),
    ends_at: hhmm(record.ends_at),
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
    delivery_fee_uzs: record.delivery_fee_uzs,
    total_uzs: record.total_uzs,
    item_count: record.item_count,
    payment_method: record.payment_method as PaymentMethod,
    recipient_name: record.recipient_name,
    recipient_phone: record.recipient_phone,
    address: orderAddress(record.address),
    delivery_slot: orderDeliverySlot(record.delivery_slot),
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
    })),
    page,
    page_size: pageSize,
    total: record.total,
    total_pages: Math.ceil(record.total / pageSize),
  };
}
