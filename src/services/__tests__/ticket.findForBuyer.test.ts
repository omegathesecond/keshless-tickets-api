import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { Ticket } from '@models/ticket.model';
import { PaymentMethod, TicketStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('TicketService.findTicketsForBuyer', () => {
  it('matches tickets by buyerId, phone, or email', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const buyerId = new mongoose.Types.ObjectId();

    const a = await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      buyerId, status: TicketStatus.SOLD,
    });
    const b = await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      customerPhone: '+26878422613', status: TicketStatus.SOLD,
    });
    const c = await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      customerEmail: 'b@x.com', status: TicketStatus.SOLD,
    });

    const found = await TicketService.findTicketsForBuyer({
      _id: buyerId, phone: '+26878422613', email: 'b@x.com',
    });

    expect(found.map((t: any) => t.ticketId).sort()).toEqual(
      [a.ticketId, b.ticketId, c.ticketId].sort()
    );
  });

  it('does not pull unrelated tickets matched by only one handle', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    const buyerId = new mongoose.Types.ObjectId();

    const mine = await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      customerEmail: 'mine@x.com', status: TicketStatus.SOLD,
    });
    await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      buyerId: new mongoose.Types.ObjectId(), status: TicketStatus.SOLD,
    });
    await Ticket.create({
      eventId, vendorId, ticketType: 'GA', price: 0,
      customerPhone: '+26876123456', status: TicketStatus.SOLD,
    });

    const found = await TicketService.findTicketsForBuyer({
      _id: buyerId, email: 'mine@x.com',
    });

    expect(found.map((t: any) => t.ticketId)).toEqual([mine.ticketId]);
  });
});

describe('TicketService.sellTickets stamps buyer identity', () => {
  it('stamps buyerId + lowercased customerEmail onto the sale and every minted ticket', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 50, capacity: 5 });
    const buyerId = new mongoose.Types.ObjectId().toString();

    const { sale, tickets } = await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      vendorId,
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerEmail: 'Buyer@Example.com',
      buyerId,
    });

    expect((sale as any).buyerId?.toString()).toBe(buyerId);
    expect((sale as any).customerEmail).toBe('buyer@example.com');
    expect(tickets).toHaveLength(2);
    for (const t of tickets) {
      expect((t as any).buyerId?.toString()).toBe(buyerId);
      expect((t as any).customerEmail).toBe('buyer@example.com');
    }

    // And findTicketsForBuyer picks them up by buyerId alone.
    const found = await TicketService.findTicketsForBuyer({ _id: buyerId });
    expect(found).toHaveLength(2);
  });
});
