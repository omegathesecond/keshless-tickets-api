import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketService } from '../ticket.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedFreeCapEvent() {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-free-cap' });
  const event = await Event.create({
    vendorId: vendor._id,
    name: 'Legends Cup 2027',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    maxTicketsPerAccount: 1,
    ticketTypes: [{ name: 'Free GA', price: 0, quantity: 999, sold: 0 }],
  });
  return { event, ticketTypeId: String(event.ticketTypes[0]!._id) };
}

describe('per-account cap — free-claim path', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets a buyer claim once, then blocks a second free claim', async () => {
    const { event, ticketTypeId } = await seedFreeCapEvent();
    const buyerId = new mongoose.Types.ObjectId().toString();

    const first = await TicketService.claimFreeTicket({
      eventId: String(event._id),
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      buyerId,
      customerPhone: '76000123',
    });
    expect(first.tickets).toHaveLength(1);

    await expect(
      TicketService.claimFreeTicket({
        eventId: String(event._id),
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        buyerId,
        customerPhone: '76000123',
      }),
    ).rejects.toThrow(/one per person/i);
  });

  it('lets a different buyer still claim', async () => {
    const { event, ticketTypeId } = await seedFreeCapEvent();
    await TicketService.claimFreeTicket({
      eventId: String(event._id),
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      buyerId: new mongoose.Types.ObjectId().toString(),
      customerPhone: '76000001',
    });
    const other = await TicketService.claimFreeTicket({
      eventId: String(event._id),
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      buyerId: new mongoose.Types.ObjectId().toString(),
      customerPhone: '76000002',
    });
    expect(other.tickets).toHaveLength(1);
  });
});
