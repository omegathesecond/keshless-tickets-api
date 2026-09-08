/**
 * resolveCart is the single pre-payment decision point for a multi-tier
 * checkout: it validates every line against the event, prices them, and
 * returns what the rails need to charge and mint. Every rail funnels through
 * it, so a rule proven here holds for MoMo, Peach, Yoco, YeboPay, the Keshless
 * wallet and the free-claim path alike.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers, type SeedTierInput } from '../../__tests__/helpers/fixtures';
import { resolveCart, mergeCartLines } from '@services/cart.service';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); });
afterAll(disconnectTestDb);

const TWO_TIERS: SeedTierInput[] = [
  { name: 'General', price: 100, quantity: 10 },
  { name: 'VIP', price: 250, quantity: 5 },
];

async function seedEvent(tiers: SeedTierInput[] = TWO_TIERS) {
  const { event } = await seedEventWithTiers(tiers);
  return event;
}

describe('mergeCartLines', () => {
  it('merges duplicate ticketTypeIds so checks cannot be split', () => {
    expect(mergeCartLines([
      { ticketTypeId: 'A', quantity: 1 },
      { ticketTypeId: 'A', quantity: 2 },
    ])).toEqual([{ ticketTypeId: 'A', quantity: 3 }]);
  });

  it('rejects a non-positive quantity', () => {
    expect(() => mergeCartLines([{ ticketTypeId: 'A', quantity: 0 }])).toThrow(/quantity/i);
  });

  it('rejects an empty cart', () => {
    expect(() => mergeCartLines([])).toThrow(/at least one/i);
  });
});

describe('resolveCart — line validation', () => {
  it('prices a mixed cart across two tiers', async () => {
    const event = await seedEvent();
    const gen = event.ticketTypes[0]!._id!.toString();
    const vip = event.ticketTypes[1]!._id!.toString();

    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: vip, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.lines).toHaveLength(2);
    expect(cart.totalQuantity).toBe(3);
    expect(cart.faceTotal).toBe(450); // 2*100 + 1*250
    expect(cart.lines[0]!.subtotal).toBe(200);
    expect(cart.lines[1]!.subtotal).toBe(250);
  });

  it('rejects a tier that does not belong to the event', async () => {
    const event = await seedEvent();
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/ticket type not found/i);
  });

  it('rejects the WHOLE cart when one line is short, naming the tier', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'VIP', price: 250, quantity: 1 },
    ]);
    const gen = event.ticketTypes[0]!._id!.toString();
    const vip = event.ticketTypes[1]!._id!.toString();

    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: vip, quantity: 3 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/VIP/);
  });

  it('rejects a manually sold-out tier even with stock on hand', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, isSoldOut: true },
    ]);
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/sold out/i);
  });

  it('rejects an unpublished event', async () => {
    const event = await seedEvent();
    event.status = EventStatus.DRAFT;
    await event.save();
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/not available|draft/i);
  });
});
