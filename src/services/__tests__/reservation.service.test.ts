import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ReservationService } from '@services/reservation.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

// Helper to create a minimal seeded event + sale for tests
async function seedEventAndSale(overrides: { reserved?: number; sold?: number } = {}) {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Test Event',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      {
        name: 'General',
        price: 100,
        quantity: 10,
        sold: overrides.sold ?? 0,
        reserved: overrides.reserved ?? 0,
      },
    ],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();

  const sale = await TicketSale.create({
    eventId: event._id,
    vendorId,
    ticketIds: [],
    quantity: 3,
    totalAmount: 300,
    paymentMethod: PaymentMethod.MTN_MOMO,
    paymentStatus: PaymentStatus.PENDING,
    soldBy: vendorId,
    soldByType: 'Vendor',
    soldAt: new Date(),
  });

  return { event, ticketTypeId, saleId: sale._id.toString(), eventId: event._id.toString(), sale };
}

describe('ReservationService.reserve — missing event/ticketType', () => {
  it('throws when event does not exist and does NOT create a reservation', async () => {
    const { ticketTypeId, saleId } = await seedEventAndSale();
    const fakeEventId = new mongoose.Types.ObjectId().toString();

    await expect(
      ReservationService.reserve({
        eventId: fakeEventId,
        lines: [{ ticketTypeId, quantity: 1 }],
        saleId,
        ttlMs: 300_000,
      })
    ).rejects.toThrow(/adjustReserved/);

    // No reservation document should have been created
    const { TicketReservation } = await import('@models/ticketReservation.model');
    const count = await TicketReservation.countDocuments({ saleId });
    expect(count).toBe(0);
  });

  it('throws when ticketType does not exist on the event', async () => {
    const { eventId, saleId } = await seedEventAndSale();
    const fakeTicketTypeId = new mongoose.Types.ObjectId().toString();

    await expect(
      ReservationService.reserve({
        eventId,
        lines: [{ ticketTypeId: fakeTicketTypeId, quantity: 1 }],
        saleId,
        ttlMs: 300_000,
      })
    ).rejects.toThrow(/adjustReserved/);

    const { TicketReservation } = await import('@models/ticketReservation.model');
    const count = await TicketReservation.countDocuments({ saleId });
    expect(count).toBe(0);
  });
});

describe('ReservationService.reserve', () => {
  it('increments ticketType.reserved and reduces availability', async () => {
    const { eventId, ticketTypeId, saleId } = await seedEventAndSale();

    const { reservationId } = await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId, quantity: 3 }],
      saleId,
      ttlMs: 300_000,
    });

    expect(reservationId).toBeTruthy();

    const updated = await Event.findById(eventId);
    const tt = updated!.ticketTypes[0]!;
    expect(tt.reserved).toBe(3);
    expect(tt.available).toBe(7); // 10 - 0 sold - 3 reserved
  });
});

describe('ReservationService.release', () => {
  it('decrements reserved back to 0 after release', async () => {
    const { eventId, ticketTypeId, saleId } = await seedEventAndSale();

    await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId, quantity: 3 }],
      saleId,
      ttlMs: 300_000,
    });

    await ReservationService.release(saleId);

    const updated = await Event.findById(eventId);
    const tt = updated!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.available).toBe(10);
  });
});

describe('ReservationService.sweepExpired', () => {
  it('releases a lapsed reservation and fails its PENDING sale', async () => {
    const { eventId, ticketTypeId, saleId } = await seedEventAndSale();

    // create reservation with negative ttl so it is already expired
    await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId, quantity: 3 }],
      saleId,
      ttlMs: -1000, // already expired
    });

    const n = await ReservationService.sweepExpired();
    expect(n).toBeGreaterThanOrEqual(1);

    const updated = await Event.findById(eventId);
    const tt = updated!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.available).toBe(10);

    const updatedSale = await TicketSale.findById(saleId);
    expect(updatedSale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  // Regression: a MoMo request-to-pay can settle AFTER our 5-minute hold lapses
  // (slow PIN entry). Failing the sale on a TIMER, without ever asking MTN,
  // destroys a real debit — the buyer is charged and no ticket is ever minted.
  // The hold must still be freed; only the payment VERDICT is deferred to the
  // processor-authoritative reconcile.
  it('frees the hold but leaves a lapsed MoMo sale PENDING when MTN can still be asked', async () => {
    const { eventId, ticketTypeId, saleId } = await seedEventAndSale();
    await TicketSale.updateOne({ _id: saleId }, { $set: { momoReferenceId: 'REF-LATE-SETTLE' } });

    await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId, quantity: 3 }],
      saleId,
      ttlMs: -1000, // already expired
    });

    await ReservationService.sweepExpired();

    // Inventory is freed — no oversell risk from deferring the verdict.
    const updated = await Event.findById(eventId);
    const tt = updated!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.available).toBe(10);

    // ...but the sale is untouched, so a late SUCCESSFUL can still mint it.
    const updatedSale = await TicketSale.findById(saleId);
    expect(updatedSale!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  // The carve-out is conditional on being ABLE to ask. With no referenceId there
  // is nothing to query, so the sale must still fail on expiry rather than
  // linger PENDING forever.
  it('still fails a lapsed MoMo sale that has no referenceId to query', async () => {
    const { eventId, ticketTypeId, saleId } = await seedEventAndSale();

    await ReservationService.reserve({
      eventId,
      lines: [{ ticketTypeId, quantity: 3 }],
      saleId,
      ttlMs: -1000,
    });

    await ReservationService.sweepExpired();

    const updatedSale = await TicketSale.findById(saleId);
    expect(updatedSale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });
});
