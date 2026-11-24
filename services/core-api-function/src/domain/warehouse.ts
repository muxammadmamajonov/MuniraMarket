/**
 * Warehouse integration seam: value objects and the connector port, as pure typing only (port of
 * services/api/app/domain/warehouse.py).
 *
 * See `architecture/0012-warehouse-integration-boundary.md`. Only the Core API talks to an
 * external warehouse, through an implementation of `WarehouseConnector`; browsers never do. Until
 * the vendor contract exists nothing implements this interface and nothing imports this module:
 * it changes no behaviour (a test keeps it unwired). Credentials never appear here.
 */

/** One product SKU mapped to exactly one external warehouse item id. */
export interface ExternalItemRef {
  readonly sku: string;
  readonly externalItemId: string;
}

/** Availability of one item as reported by the warehouse at `asOf`. */
export interface StockLevel {
  readonly item: ExternalItemRef;
  readonly availableQuantity: number;
  readonly asOf: Date;
}

export interface ReservationLine {
  readonly sku: string;
  readonly quantity: number;
}

/** Reserve stock for one order attempt; `idempotencyKey` repeats on every retry. */
export interface ReservationRequest {
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly lines: readonly ReservationLine[];
}

export interface ReservationResult {
  readonly reservationId: string;
  readonly idempotencyKey: string;
}

/** Port to the external warehouse. Every mutating call is idempotent by its key. */
export interface WarehouseConnector {
  fetchStock(skus: readonly string[]): Promise<readonly StockLevel[]>;
  reserve(request: ReservationRequest): Promise<ReservationResult>;
  commit(reservationId: string, idempotencyKey: string): Promise<void>;
  cancel(reservationId: string, idempotencyKey: string): Promise<void>;
}
