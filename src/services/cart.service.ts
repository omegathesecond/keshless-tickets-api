import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, TicketStatus } from '@interfaces/ticket.interface';
import { assertCarrotTicketing } from '@utils/ticketingGuard.util';
import { computeAvailable } from '@services/event.service';
import { round2 } from '@utils/serviceFee.util';
import { Ticket } from '@models/ticket.model';
import { normalizePhone } from '@utils/phone.util';
import type { CartLine, ResolvedCart, ResolvedLine } from '@interfaces/cart.interface';

/**
 * Collapses duplicate tiers so every downstream check sees one line per tier.
 *
 * Without this, `[{A,1},{A,2}]` would be validated as two independent 1- and
 * 2-ticket orders and could slip past a per-tier availability check or the
 * per-account cap that a single 3-ticket line would have failed.
 */
export function mergeCartLines(items: CartLine[]): CartLine[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A cart must contain at least one ticket');
  }
  const byTier = new Map<string, number>();
  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new Error('Each ticket line needs a whole quantity of at least 1');
    }
    byTier.set(item.ticketTypeId, (byTier.get(item.ticketTypeId) ?? 0) + qty);
  }
  return [...byTier].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
}

/**
 * `maxTicketsPerAccount` is a per-EVENT cap, so it must be measured against the
 * buyer's existing tickets PLUS every line in this cart at once. Checking it
 * per line is the bypass multi-tier introduces: a 4-ticket cap on a nine-tier
 * event would otherwise permit 36.
 *
 * Skipped when the organizer set no cap, or when the caller has no identity to
 * bind (POS walk-up, wristband batch, reseller allocation) — an account rule
 * cannot constrain someone with no account and no phone.
 */
async function assertWithinAccountCap(p: {
  eventId: string;
  cap?: number;
  requested: number;
  buyerId?: string;
  phone?: string;
}): Promise<void> {
  const { cap } = p;
  if (typeof cap !== 'number' || cap <= 0) return;

  const identityClauses: Array<Record<string, unknown>> = [];
  if (p.buyerId) identityClauses.push({ buyerId: p.buyerId });
  const normPhone = p.phone ? normalizePhone(p.phone) : '';
  if (normPhone) identityClauses.push({ customerPhone: normPhone });
  if (identityClauses.length === 0) return;

  const held = await Ticket.countDocuments({
    eventId: p.eventId,
    status: { $nin: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
    $or: identityClauses,
  });

  if (held + p.requested > cap) {
    throw new Error(
      cap === 1
        ? "You already have your ticket for this event — it's limited to one per person."
        : `This event is limited to ${cap} tickets per person; you already have ${held}.`
    );
  }
}

/**
 * The single pre-payment decision point for a checkout: validates every line
 * against the event, prices them, and returns what the rails need to charge
 * and mint. Every rail calls this, so a rule enforced here holds everywhere.
 *
 * It never trims a cart to what happens to be available — a cart that cannot
 * be satisfied in full throws, naming the tier at fault.
 */
export async function resolveCart(input: {
  eventId: string;
  items: CartLine[];
  method: PaymentMethod;
  buyerId?: string;
  phone?: string;
}): Promise<ResolvedCart> {
  const items = mergeCartLines(input.items);

  const event = await Event.findOne({ _id: input.eventId, status: EventStatus.PUBLISHED });
  if (!event) throw new Error('Event not found or not available');
  assertCarrotTicketing(event);

  const lines: ResolvedLine[] = [];
  for (const item of items) {
    const ticketType = event.ticketTypes.find((tt) => tt._id?.toString() === item.ticketTypeId);
    if (!ticketType) throw new Error('Ticket type not found');

    // The organizer's manual override comes first: a tier flagged sold out
    // keeps a positive computed availability (the dashboard only sets the
    // flag), so checking the count alone would let it keep selling.
    if (ticketType.isSoldOut) {
      throw new Error(`${ticketType.name} is sold out`);
    }
    const availableNow = computeAvailable(ticketType);
    if (availableNow < item.quantity) {
      throw new Error(`Only ${availableNow} ${ticketType.name} tickets available`);
    }

    lines.push({
      ticketTypeId: item.ticketTypeId,
      ticketType,
      quantity: item.quantity,
      unitPrice: ticketType.price,
      subtotal: round2(ticketType.price * item.quantity),
    });
  }

  const faceTotal = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);

  await assertWithinAccountCap({
    eventId: input.eventId,
    cap: event.maxTicketsPerAccount,
    requested: totalQuantity,
    buyerId: input.buyerId,
    phone: input.phone,
  });

  return {
    event,
    lines,
    totalQuantity,
    faceTotal,
    serviceFeeAmount: 0,
    absorbedServiceFeeAmount: 0,
    amountCharged: faceTotal,
  };
}
