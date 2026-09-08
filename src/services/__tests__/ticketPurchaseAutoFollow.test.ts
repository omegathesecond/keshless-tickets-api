import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { FollowService } from '@services/follow.service';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Follow } from '@models/follow.model';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('ticket purchase auto-follows the organizer', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Follow.init(); // unique index must exist before idempotency races it
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  let vseq = 0;
  const makeOrganizer = () => {
    vseq += 1;
    return Vendor.create({
      businessName: `Organizer ${vseq}`,
      email: `organizer${vseq}@example.com`,
      phoneNumber: `+2687${8100000 + vseq}`,
      password: 'secret123',
    });
  };
  const seedBuyer = (phone: string): Promise<IBuyer> =>
    Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}` });

  it('a registered buyer who buys a ticket auto-follows the organizer', async () => {
    const organizer = await makeOrganizer();
    const buyer = await seedBuyer('+26878200001');
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 5,
      vendorId: organizer._id,
    });

    await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      buyerId: String(buyer._id),
    });

    expect(await FollowService.followerCount('organizer', String(organizer._id))).toBe(1);
    expect(await FollowService.followingIds(String(buyer._id), 'organizer')).toEqual([
      String(organizer._id),
    ]);
  });

  it('a guest purchase with no buyerId creates no follow (registered buyers only)', async () => {
    const organizer = await makeOrganizer();
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 5,
      vendorId: organizer._id,
    });

    await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerPhone: '+26878200002',
    });

    expect(await FollowService.followerCount('organizer', String(organizer._id))).toBe(0);
  });

  it('a second purchase by the same buyer keeps a single follow edge', async () => {
    const organizer = await makeOrganizer();
    const buyer = await seedBuyer('+26878200003');
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 5,
      vendorId: organizer._id,
    });

    const sell = () =>
      TicketService.sellTickets({
        eventId,
        lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        vendorId,
        paymentMethod: PaymentMethod.CASH,
        soldBy: vendorId,
        soldByType: 'vendor',
        buyerId: String(buyer._id),
      });
    await sell();
    await sell();

    expect(await FollowService.followerCount('organizer', String(organizer._id))).toBe(1);
  });
});
