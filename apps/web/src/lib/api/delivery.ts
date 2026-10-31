import type { DeliveryZoneList } from '@muniramarket/contracts';
import type { ApiFetch } from './cart';
import { requestJson } from './request';

/** `GET /delivery/zones`: active zones only, with their districts, fees and hours. Public. */
export function getDeliveryZones(apiFetch: ApiFetch): Promise<DeliveryZoneList> {
  return requestJson<DeliveryZoneList>(apiFetch, '/delivery/zones', { method: 'GET' });
}
