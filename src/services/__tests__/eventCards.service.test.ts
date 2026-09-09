import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { SalesChannel, PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { buildEventCards } from '@services/eventCards.service';
import { toggleEventSave } from '@services/eventReaction.service';
import type { SocialActor } from '@utils/socialActor.util';

describe('buildEventCards', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns cards in the requested id order with organizer attached', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e1 = await Event.create({ vendorId: v._id, name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const e2 = await Event.create({ vendorId: v._id, name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 50, quantity: 10, available: 10 }] });
    const cards = await buildEventCards([String(e2._id), String(e1._id)], null);
    expect(cards.map((c) => c.name)).toEqual(['B', 'A']);
    expect(cards[0].organizer.businessName).toBe('MTN Bushfire');
  });

  it('returns [] for no ids', async () => {
    expect(await buildEventCards([], null)).toEqual([]);
  });

  it('includes likeCount matching the event\'s stored value (parity with the public list card)', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e = await Event.create({ vendorId: v._id, name: 'Liked Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), likeCount: 7, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const [card] = await buildEventCards([String(e._id)], null);
    expect(card.likeCount).toBe(7);
  });

  it('resolves organizer to null when the vendor is inactive (parity with the public list)', async () => {
    const v = await Vendor.create({ businessName: 'Deactivated Vendor', password: 'secret123', isActive: false });
    const e = await Event.create({ vendorId: v._id, name: 'Orphaned Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const [card] = await buildEventCards([String(e._id)], null);
    expect(card.organizer).toBeNull();
  });

  // FINDING 1 fix: viewerHasSaved was a dead capability on this read path —
  // buildEventCards only ever resolved viewerHasLiked. It must now also
  // resolve the independent 'save' reaction so the bookmark UI can restore
  // its filled state after reload.
  it('serializes viewerHasSaved:true for the actor who saved and false for a non-actor, leaving viewerHasLiked unaffected', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e = await Event.create({ vendorId: v._id, name: 'Saved Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const saver: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };
    const other: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };
    await toggleEventSave(String(e._id), saver);

    const [saverCard] = await buildEventCards([String(e._id)], saver);
    expect(saverCard.viewerHasSaved).toBe(true);
    expect(saverCard.viewerHasLiked).toBe(false);

    const [otherCard] = await buildEventCards([String(e._id)], other);
    expect(otherCard.viewerHasSaved).toBe(false);
  });

  // Regression: buildEventCards used to omit recentSales entirely, so a
  // recommended/saved-event card showed a bare 0 next to the people icon
  // while a "Hot This Week" card (sourced from the main public events list,
  // which DOES apply this same blend) showed a real number for the identical
  // event. Both surfaces must now agree.
  it('never returns recentSales:0 — always the same blended real+synthetic number the public list card would show', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e = await Event.create({ vendorId: v._id, name: 'Quiet Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });
    const [card] = await buildEventCards([String(e._id)], null);
    expect(card.recentSales).toBeGreaterThan(0);
  });

  it('reflects real recent completed sales (non-wristband, last 48h) into recentSales', async () => {
    const v = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret123' });
    const e = await Event.create({ vendorId: v._id, name: 'Selling Fast', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 100, quantity: 100, available: 100 }] });
    await TicketSale.create({
      eventId: e._id,
      vendorId: v._id,
      ticketIds: [new mongoose.Types.ObjectId()],
      quantity: 25,
      totalAmount: 2500,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.COMPLETED,
      soldBy: new mongoose.Types.ObjectId(),
      soldByType: 'Vendor' as const,
      channel: SalesChannel.ONLINE,
      soldAt: new Date(),
    });
    const [card] = await buildEventCards([String(e._id)], null);
    expect(card.recentSales).toBeGreaterThanOrEqual(25);
  });
});
