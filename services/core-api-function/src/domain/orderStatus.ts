/** Order lifecycle: allowed status transitions (port of services/api/app/domain/order_status.py). */

/** Declaration order is the documented order (`allowed_transitions` is sorted by it). */
export const ORDER_STATUSES = [
  'NEW',
  'CONFIRMED',
  'PICKING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['DELIVERED', 'CANCELLED']);

const FORWARD: Readonly<Partial<Record<OrderStatus, OrderStatus>>> = {
  NEW: 'CONFIRMED',
  CONFIRMED: 'PICKING',
  PICKING: 'READY_FOR_DELIVERY',
  READY_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  OUT_FOR_DELIVERY: 'DELIVERED',
};

/** Every non-final status may move one step forward or be cancelled; final ones have no exit. */
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, ReadonlySet<OrderStatus>>> =
  Object.fromEntries(
    ORDER_STATUSES.map((status) => {
      const next = FORWARD[status];
      return [
        status,
        new Set<OrderStatus>(
          FINAL_STATUSES.has(status) || next === undefined ? [] : [next, 'CANCELLED'],
        ),
      ];
    }),
  ) as unknown as Record<OrderStatus, ReadonlySet<OrderStatus>>;

/** A customer may cancel only before the order is being picked; later, only an operator can. */
export const CUSTOMER_CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'NEW',
  'CONFIRMED',
]);

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Staff may lower an order line (the goods are not there, ADR 0018) until it is packed. */
export const ADJUSTABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'NEW',
  'CONFIRMED',
  'PICKING',
]);

/**
 * Before picking always; while PICKING only when staff lowered a line of the order (`adjusted`):
 * the customer did not agree to the smaller order and may back out (ADR 0018).
 */
export function customerCanCancel(current: OrderStatus, adjusted = false): boolean {
  if (CUSTOMER_CANCELLABLE_STATUSES.has(current)) return true;
  return adjusted && current === 'PICKING';
}

export function canAdjustItems(current: OrderStatus): boolean {
  return ADJUSTABLE_STATUSES.has(current);
}

export class InvalidOrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderTransitionError';
  }
}

/** Whether `current -> target` is allowed. Cancelling requires a non-blank `cancelReason`. */
export function canTransition(
  current: OrderStatus,
  target: OrderStatus,
  cancelReason: string | null = null,
): boolean {
  if (!ALLOWED_TRANSITIONS[current].has(target)) return false;
  if (target === 'CANCELLED') return cancelReason !== null && cancelReason.trim() !== '';
  return true;
}

export function ensureTransition(
  current: OrderStatus,
  target: OrderStatus,
  cancelReason: string | null = null,
): void {
  if (!canTransition(current, target, cancelReason)) {
    throw new InvalidOrderTransitionError(`Cannot move order from ${current} to ${target}`);
  }
}

/** The statuses `current` may move to, in declaration order. */
export function allowedTransitionsOf(current: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((status) => ALLOWED_TRANSITIONS[current].has(status));
}

/** Tabs of the customer's order history (`GET /orders?status_group=`). */
export const ORDER_STATUS_GROUPS = ['all', 'active', 'delivering', 'done', 'cancelled'] as const;
export type OrderStatusGroup = (typeof ORDER_STATUS_GROUPS)[number];

/** The statuses each group lists; `all` lists every status. */
export const ORDER_STATUS_GROUP_STATUSES: Readonly<
  Record<OrderStatusGroup, readonly OrderStatus[]>
> = {
  all: ORDER_STATUSES,
  active: ['NEW', 'CONFIRMED', 'PICKING', 'READY_FOR_DELIVERY'],
  delivering: ['OUT_FOR_DELIVERY'],
  done: ['DELIVERED'],
  cancelled: ['CANCELLED'],
};
