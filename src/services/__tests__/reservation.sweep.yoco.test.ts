/**
 * ReservationService.sweepExpired — Yoco carve-out.
 *
 * WHY THIS EXISTS: every other async rail can recover a stuck sale by asking the
 * provider "was this actually paid?" (Peach getPaymentStatus, DeltaPay
 * verify-return, MoMo requestToPay status). Yoco publishes NO status-query
 * endpoint, so a Yoco sale the sweep marks FAILED is unrecoverable — a webhook
 * arriving afterwards finds a non-PENDING sale and idempotently reports
 * 'failed', leaving the buyer charged with no ticket and no trace.
 *
 * So the sweep still RELEASES the inventory hold for Yoco (inventory must never
 * be held forever) but must NOT fail the sale.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ReservationService } from '@services/reservation.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedLapsedSale(paymentMethod: PaymentMethod) {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Sweep Test Event',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  const ticketTypeId = event.ticketTypes[0]!._id!.toString();

  const sale = await TicketSale.create({
    eventId: event._id,
    vendorId,
    ticketIds: [],
    quantity: 3,
    totalAmount: 300,
    paymentMethod,
    paymentStatus: PaymentStatus.PENDING,
    soldBy: vendorId,
    soldByType: 'Vendor',
    soldAt: new Date(),
  });

  await ReservationService.reserve({
    eventId: event._id.toString(),
    lines: [{ ticketTypeId, quantity: 3 }],
    saleId: sale._id.toString(),
    ttlMs: -1000, // already expired
  });

  return { event, saleId: sale._id.toString(), eventId: event._id.toString() };
}

describe('sweepExpired — Yoco', () => {
  it('releases the inventory hold on a lapsed Yoco reservation', async () => {
    const { eventId } = await seedLapsedSale(PaymentMethod.YOCO);

    await ReservationService.sweepExpired();

    const updated = await Event.findById(eventId);
    expect(updated!.ticketTypes[0]!.reserved).toBe(0);
    expect(updated!.ticketTypes[0]!.available).toBe(10);
  });

  it('leaves the Yoco sale PENDING so a late signed webhook can still resolve it', async () => {
    const { saleId } = await seedLapsedSale(PaymentMethod.YOCO);

    await ReservationService.sweepExpired();

    const sale = await TicketSale.findById(saleId);
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('still fails a lapsed sale on rails that CAN be reconciled against the provider', async () => {
    const { saleId } = await seedLapsedSale(PaymentMethod.MTN_MOMO);

    await ReservationService.sweepExpired();

    const sale = await TicketSale.findById(saleId);
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
  });
});
