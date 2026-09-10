import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VoteQuestion } from '@models/voteQuestion.model';
import { AttendeeTag } from '@models/attendeeTag.model';
import { BlockService } from '@services/block.service';
import { VoteTagService } from '@services/voteTag.service';

const mk = (phone: string, username: string) => Buyer.create({ phone, password: 'secret1', username }) as unknown as Promise<IBuyer>;

async function seedAttendingWithQuestion() {
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Tag Test Event',
    venue: 'Test Venue',
    eventDate: new Date(),
    startTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
  });
  const question = await VoteQuestion.create({
    eventId: event._id,
    kind: 'attending_with',
    prompt: 'Who are you attending with?',
    order: 0,
    options: [{ key: 'friends', label: 'Friends' }],
  });
  return { event, question };
}

describe('VoteTagService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AttendeeTag.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('request creates a pending tag and notifies the target', async () => {
    const { question } = await seedAttendingWithQuestion();
    const tagger = await mk('+26878500001', 'tagger_a');
    const target = await mk('+26878500002', 'target_a');
    const tag = await VoteTagService.request(tagger, String(question._id), String(target._id));
    expect(tag.status).toBe('pending');
  });

  it('rejects self-tag, unknown target, and duplicate tag requests', async () => {
    const { question } = await seedAttendingWithQuestion();
    const tagger = await mk('+26878500003', 'tagger_b');
    await expect(VoteTagService.request(tagger, String(question._id), String(tagger._id))).rejects.toMatchObject({ statusCode: 400 });
    await expect(VoteTagService.request(tagger, String(question._id), '5f'.repeat(12))).rejects.toMatchObject({ statusCode: 404 });

    const target = await mk('+26878500004', 'target_b');
    await VoteTagService.request(tagger, String(question._id), String(target._id));
    await expect(VoteTagService.request(tagger, String(question._id), String(target._id))).rejects.toMatchObject({ statusCode: 409 });
    expect(await AttendeeTag.countDocuments({})).toBe(1);
  });

  it('respects blocked-user relationships in either direction', async () => {
    const { question } = await seedAttendingWithQuestion();
    const tagger = await mk('+26878500005', 'tagger_c');
    const target = await mk('+26878500006', 'target_c');
    await BlockService.block(target, String(tagger._id)); // target blocked tagger
    await expect(VoteTagService.request(tagger, String(question._id), String(target._id))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('only the tagged user may confirm/decline, and only while pending', async () => {
    const { question } = await seedAttendingWithQuestion();
    const tagger = await mk('+26878500007', 'tagger_d');
    const target = await mk('+26878500008', 'target_d');
    const tag = await VoteTagService.request(tagger, String(question._id), String(target._id));

    await expect(VoteTagService.confirm(tagger, String(tag._id))).rejects.toMatchObject({ statusCode: 403 });
    await VoteTagService.confirm(target, String(tag._id));
    const confirmed = await AttendeeTag.findById(tag._id);
    expect(confirmed!.status).toBe('confirmed');
    expect(confirmed!.respondedAt).toBeInstanceOf(Date);

    await expect(VoteTagService.decline(target, String(tag._id))).rejects.toMatchObject({ statusCode: 409 }); // no longer pending
  });

  it('the tagger can remove a tag in any status; the target cannot', async () => {
    const { question } = await seedAttendingWithQuestion();
    const tagger = await mk('+26878500009', 'tagger_e');
    const target = await mk('+26878500010', 'target_e');
    const tag = await VoteTagService.request(tagger, String(question._id), String(target._id));
    await VoteTagService.decline(target, String(tag._id));

    await expect(VoteTagService.remove(target, String(tag._id))).rejects.toMatchObject({ statusCode: 403 });
    await VoteTagService.remove(tagger, String(tag._id));
    expect(await AttendeeTag.findById(tag._id)).toBeNull();
  });
});
