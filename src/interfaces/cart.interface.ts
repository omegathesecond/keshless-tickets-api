import type { IEvent, ITicketType } from '@interfaces/event.interface';

/**
 * One tier plus how many of it — the wire shape a client sends. A single-tier
 * purchase is a one-element array, which is what every caller sent implicitly
 * before multi-tier checkout existed.
 */
export interface CartLine {
  ticketTypeId: string;
  quantity: number;
}

/** A CartLine after its tier has been found on the event and priced. */
export interface ResolvedLine {
  ticketTypeId: string;
  /** The tier snapshot, so callers never re-look-up (and never disagree). */
  ticketType: ITicketType;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/**
 * Everything the payment rails need to charge and mint, produced ONLY by
 * resolveCart. Money here is already final: `faceTotal` is what the tickets
 * cost, `serviceFeeAmount` what the buyer pays on top, and `amountCharged`
 * the sum actually taken. `absorbedServiceFeeAmount` is the fee an organizer
 * covers instead of the buyer (netted out of their proceeds, never charged).
 */
export interface ResolvedCart {
  event: IEvent;
  lines: ResolvedLine[];
  totalQuantity: number;
  faceTotal: number;
  serviceFeeAmount: number;
  absorbedServiceFeeAmount: number;
  amountCharged: number;
}
