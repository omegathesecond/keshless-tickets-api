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
import { PaymentMethod, TicketStatus } from '@interfaces/ticket.interface';
import { Ticket } from '@models/ticket.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { computeServiceFee } from '@utils/serviceFee.util';

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

describe('resolveCart — per-account cap', () => {
  it('sums the WHOLE cart against the cap, not each line', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(TWO_TIERS, { maxTicketsPerAccount: 3 });

    // 2 + 2 = 4 > cap of 3, though NEITHER line alone exceeds it.
    await expect(resolveCart({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 2 },
      ],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: new mongoose.Types.ObjectId().toString(),
    })).rejects.toThrow(/limited to 3/i);
  });

  it('counts tickets the buyer already holds for this event', async () => {
    const { eventId, ticketTypeIds, event } = await seedEventWithTiers(TWO_TIERS, { maxTicketsPerAccount: 2 });
    const buyerId = new mongoose.Types.ObjectId();

    await Ticket.create({
      eventId: event._id, vendorId: event.vendorId, ticketType: 'General',
      price: 100, buyerId, status: TicketStatus.SOLD,
    });

    await expect(resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: buyerId.toString(),
    })).rejects.toThrow(/limited to 2/i);
  });

  it('ignores refunded and cancelled tickets when counting', async () => {
    const { eventId, ticketTypeIds, event } = await seedEventWithTiers(TWO_TIERS, { maxTicketsPerAccount: 1 });
    const buyerId = new mongoose.Types.ObjectId();

    await Ticket.create({
      eventId: event._id, vendorId: event.vendorId, ticketType: 'General',
      price: 100, buyerId, status: TicketStatus.REFUNDED,
    });

    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: buyerId.toString(),
    });
    expect(cart.totalQuantity).toBe(1);
  });

  it('skips the cap for an anonymous caller (POS walk-up)', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(TWO_TIERS, { maxTicketsPerAccount: 1 });
    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 5 }],
      method: PaymentMethod.CASH,
    });
    expect(cart.totalQuantity).toBe(5);
  });

  it('treats an absent cap as unlimited', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(TWO_TIERS);
    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 9 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: new mongoose.Types.ObjectId().toString(),
    });
    expect(cart.totalQuantity).toBe(9);
  });

  it('binds the cap by phone when there is no buyerId', async () => {
    const { eventId, ticketTypeIds, event } = await seedEventWithTiers(TWO_TIERS, { maxTicketsPerAccount: 1 });
    await Ticket.create({
      eventId: event._id, vendorId: event.vendorId, ticketType: 'General',
      price: 100, customerPhone: '+26878422613', status: TicketStatus.SOLD,
    });

    await expect(resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
      phone: '78422613', // same person, un-normalized
    })).rejects.toThrow(/limited to one per person/i);
  });
});

describe('resolveCart — restricted and allocation tiers', () => {
  it('rejects a restricted tier bought alongside another tier', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, restrictToMethod: PaymentMethod.DELTAPAY },
    ]);

    await expect(resolveCart({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      method: PaymentMethod.DELTAPAY,
    })).rejects.toThrow(/DeltaPay Exclusive/);
  });

  it('allows a restricted tier alone on its own method', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, restrictToMethod: PaymentMethod.DELTAPAY },
    ]);
    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      method: PaymentMethod.DELTAPAY,
    });
    expect(cart.faceTotal).toBe(400);
  });

  it('rejects a restricted tier on the wrong method', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, restrictToMethod: PaymentMethod.DELTAPAY },
    ]);
    await expect(resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/can only be bought with/i);
  });

  it('rejects a cart mixing allocation and non-allocation tiers', async () => {
    const resellerId = new mongoose.Types.ObjectId();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'Reseller Block', price: 100, quantity: 10, isAllocation: true, resellerId },
    ]);

    await expect(resolveCart({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/allocation/i);
  });

  it('rejects a cart spanning two DIFFERENT resellers', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Block A', price: 100, quantity: 10, isAllocation: true, resellerId: new mongoose.Types.ObjectId() },
      { name: 'Block B', price: 150, quantity: 10, isAllocation: true, resellerId: new mongoose.Types.ObjectId() },
    ]);

    await expect(resolveCart({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/allocation/i);
  });

  it('allows several allocation tiers owned by the SAME reseller', async () => {
    const resellerId = new mongoose.Types.ObjectId();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Block A', price: 100, quantity: 10, isAllocation: true, resellerId },
      { name: 'Block B', price: 150, quantity: 10, isAllocation: true, resellerId },
    ]);
    const cart = await resolveCart({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      method: PaymentMethod.KESHLESS_WALLET,
    });
    expect(cart.faceTotal).toBe(250);
  });
});

describe('resolveCart — service fee', () => {
  // A real per-ticket fee, so "per line then summed" is actually observable.
  beforeEach(async () => { await PaymentConfigService.update({ keshlessServiceFee: 5 }); });

  it('charges a mixed waived/non-waived cart the SUM of the two bought separately', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'Waived', price: 100, quantity: 10, waiveServiceFee: true },
    ]);
    const method = PaymentMethod.KESHLESS_WALLET;

    const genOnly = await resolveCart({ eventId, method, items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }] });
    const waivedOnly = await resolveCart({ eventId, method, items: [{ ticketTypeId: ticketTypeIds[1]!, quantity: 3 }] });
    const together = await resolveCart({
      eventId, method,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 3 },
      ],
    });

    expect(genOnly.serviceFeeAmount).toBe(10); // 2 tickets * 5
    expect(waivedOnly.serviceFeeAmount).toBe(0);
    // The point of decision 1: a basket costs exactly what buying the tiers
    // separately costs — no buyer is better or worse off for using the cart.
    expect(together.serviceFeeAmount).toBe(genOnly.serviceFeeAmount + waivedOnly.serviceFeeAmount);
    expect(together.amountCharged).toBe(together.faceTotal + together.serviceFeeAmount);
  });

  it('routes the fee to the organizer when the event absorbs it', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(TWO_TIERS, { organizerAbsorbsServiceFee: true });

    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.serviceFeeAmount).toBe(0);
    expect(cart.absorbedServiceFeeAmount).toBe(10);
    expect(cart.amountCharged).toBe(cart.faceTotal); // buyer pays face
  });

  it('charges no fee on a free line', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([{ name: 'Free', price: 0, quantity: 10 }]);
    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });
    expect(cart.serviceFeeAmount).toBe(0);
    expect(cart.amountCharged).toBe(0);
  });

  it('matches computeServiceFee exactly for a one-line cart (equivalence)', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(TWO_TIERS);
    const cfg = await PaymentConfigService.get();
    const expected = computeServiceFee(200, 2, PaymentMethod.KESHLESS_WALLET, cfg, {});

    const cart = await resolveCart({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.serviceFeeAmount).toBe(expected.serviceFeeAmount);
    expect(cart.amountCharged).toBe(expected.amountCharged);
  });
});
