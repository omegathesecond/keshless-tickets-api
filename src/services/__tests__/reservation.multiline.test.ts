/**
 * A multi-tier cart has to hold inventory on every tier it spans while its
 * async payment (MoMo, Peach, Yoco, YeboPay, DeltaPay) is outstanding. The
 * reservation stays ONE document per sale — saleId is unique, which is what
 * makes confirm/release idempotent — and carries the tiers in `lines`.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { ReservationService } from '@services/reservation.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { TicketReservation } from '@models/ticketReservation.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); });
afterAll(disconnectTestDb);

const TIERS = [
  { name: 'General', price: 100, quantity: 10 },
  { name: 'VIP', price: 250, quantity: 5 },
];

async function seed(method: PaymentMethod = PaymentMethod.YOCO) {
  const { eventId, event, ticketTypeIds } = await seedEventWithTiers(TIERS);
  const sale = await TicketSale.create({
    eventId: event._id,
    vendorId: event.vendorId,
    ticketIds: [],
    quantity: 3,
    totalAmount: 450,
    paymentMethod: method,
    paymentStatus: PaymentStatus.PENDING,
    soldBy: event.vendorId,
    soldByType: 'Vendor',
  });
  return { eventId, event, ticketTypeIds, sale };
}

describe('ReservationService — multi-line holds', () => {
  it('holds inventory on every tier under ONE reservation document', async () => {
    const { eventId, ticketTypeIds, sale } = await seed();

    await ReservationService.reserve({
      eventId,
      lines: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(2);
    expect(after!.ticketTypes[1]!.reserved).toBe(1);
    // Availability reflects the hold, so a second buyer cannot take them.
    expect(after!.ticketTypes[0]!.available).toBe(8);
    expect(after!.ticketTypes[1]!.available).toBe(4);

    // saleId stays unique: exactly one document, not one per line.
    expect(await TicketReservation.countDocuments({ saleId: sale._id })).toBe(1);
  });

  it('releases every line', async () => {
    const { eventId, ticketTypeIds, sale } = await seed();
    await ReservationService.reserve({
      eventId,
      lines: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    await ReservationService.release(sale._id.toString());

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);
  });

  it('confirms every line', async () => {
    const { eventId, ticketTypeIds, sale } = await seed();
    await ReservationService.reserve({
      eventId,
      lines: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    await ReservationService.confirm(sale._id.toString());

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);
  });

  it('is idempotent: releasing twice does not double-decrement', async () => {
    const { eventId, ticketTypeIds, sale } = await seed();
    await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    await ReservationService.release(sale._id.toString());
    await ReservationService.release(sale._id.toString());

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('sweeps an expired multi-line hold, releasing all tiers', async () => {
    const { eventId, ticketTypeIds, sale } = await seed(PaymentMethod.MTN_MOMO);
    await ReservationService.reserve({
      eventId,
      lines: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      saleId: sale._id.toString(),
      ttlMs: -1, // already expired
    });

    const n = await ReservationService.sweepExpired();
    expect(n).toBe(1);

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);

    const swept = await TicketSale.findById(sale._id);
    expect(swept!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('still holds a single tier exactly as before (equivalence)', async () => {
    const { eventId, ticketTypeIds, sale } = await seed();
    const { expiresAt } = await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 3 }],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.reserved).toBe(3);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);
  });
});
