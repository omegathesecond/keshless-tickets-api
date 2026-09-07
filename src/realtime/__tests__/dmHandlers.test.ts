import mongoose from 'mongoose';
import { clearTestDb } from '../../__tests__/helpers/mongo';
import {
  connectAdapterTestDb,
  disconnectAdapterTestDb,
  startTestRealtime,
  connectClient,
  waitForEvent,
  TestRealtime,
} from './helpers';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Membership } from '@models/membership.model';
import { CommunityService } from '@services/community.service';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { ensureAdapterCollection } from '../adapterCollection';
import { initSocketEmitter } from '../emitter';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Socket as ClientSocket } from 'socket.io-client';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';

async function seedThread(): Promise<{ a: IBuyer; b: IBuyer; threadId: string }> {
  const a = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Alpha' });
  const b = await Buyer.create({ phone: PHONE_B, password: 'secret1', name: 'Beta' });
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  await Membership.create({ buyerId: a._id, communityId: community._id });
  await Membership.create({ buyerId: b._id, communityId: community._id });
  const thread = await DmThreadService.openThread(a, [String(b._id)]);
  return { a, b, threadId: String(thread._id) };
}

function joinDm(client: ClientSocket, threadId: string): Promise<any> {
  return new Promise((resolve) => client.emit('dm:join', { threadId }, resolve));
}

describe('dm handlers', () => {
  let rt: TestRealtime;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    await connectAdapterTestDb();
    const collection = await ensureAdapterCollection(mongoose.connection.db! as any);
    initSocketEmitter(collection);
  });
  beforeEach(async () => {
    rt = await startTestRealtime(true);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await rt.close();
    await clearTestDb();
  });
  afterAll(disconnectAdapterTestDb);

  async function client(phone: string): Promise<ClientSocket> {
    const c = await connectClient(rt.port, signBuyerToken(phone));
    clients.push(c);
    return c;
  }

  it('participant joins; non-participant is refused without existence leak', async () => {
    const { threadId } = await seedThread();
    const b = await client(PHONE_B);
    expect(await joinDm(b, threadId)).toEqual({ ok: true });

    await Buyer.create({ phone: '+26878000099', password: 'secret1' });
    const outsider = await client('+26878000099');
    const ack = await joinDm(outsider, threadId);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/conversation not found/i);
  });

  it('REST dm send reaches a joined client as message:new', async () => {
    const { a, threadId } = await seedThread();
    const b = await client(PHONE_B);
    expect(await joinDm(b, threadId)).toEqual({ ok: true });

    const [live, sent] = await Promise.all([
      waitForEvent<any>(b, 'message:new', 8000),
      MessageService.sendDmMessage(threadId, { type: 'buyer', id: String(a._id) }, { body: 'live dm' }),
    ]);
    expect(live.id).toBe(sent.id);
    expect(live.dmThreadId).toBe(threadId);
  }, 20000);

  it('a vendor joins a brand↔brand thread and receives message:new live', async () => {
    const va = await Vendor.create({ businessName: 'Alpha Ev', email: 'va@example.com', phoneNumber: '+26878004001', password: 'secret123' });
    const vb = await Vendor.create({ businessName: 'Beta Sh', email: 'vb@example.com', phoneNumber: '+26878004002', password: 'secret123' });
    const thread = await DmThreadService.openBrandToBrandThread(String(va._id), String(vb._id));
    const threadId = String(thread._id);

    const bClient = await connectClient(rt.port, signVendorToken(String(vb._id)));
    clients.push(bClient);
    expect(await joinDm(bClient, threadId)).toEqual({ ok: true });

    const [live, sent] = await Promise.all([
      waitForEvent<any>(bClient, 'message:new', 8000),
      MessageService.sendDmMessage(threadId, { type: 'vendor', id: String(va._id) }, { body: 'brand to brand live' }),
    ]);
    expect(live.id).toBe(sent.id);
    expect(live.dmThreadId).toBe(threadId);
    expect(live.sender.id).toBe(String(va._id)); // the OTHER brand, told apart by id
  }, 20000);

  it('dm:typing forwards to other room members; dropped when not in room', async () => {
    const { threadId } = await seedThread();
    const a = await client(PHONE_A);
    const b = await client(PHONE_B);
    await joinDm(a, threadId);
    await joinDm(b, threadId);

    const [typing] = await Promise.all([
      waitForEvent<any>(a, 'dm:typing'),
      (async () => b.emit('dm:typing', { threadId }))(),
    ]);
    expect(typing.threadId).toBe(threadId);
    expect(typeof typing.username).toBe('string');

    const c = await client(PHONE_B); // second connection, never joined the room
    c.emit('dm:typing', { threadId });
    await expect(waitForEvent(a, 'dm:typing', 500)).rejects.toThrow(/timeout/);
  });
});
