import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VoteQuestion } from '@models/voteQuestion.model';
import { VoteComment } from '@models/voteComment.model';
import { postComment, reactToComment, deleteOwnComment, moderateRemoveComment, listComments } from '@services/voteDiscussion.service';
import type { SocialActor } from '@utils/socialActor.util';

const mk = (phone: string, username: string) => Buyer.create({ phone, password: 'secret1', username }) as unknown as Promise<IBuyer>;

async function seedQuestion(vendorId = new mongoose.Types.ObjectId()) {
  const event = await Event.create({
    vendorId,
    name: 'Discussion Test Event',
    venue: 'Test Venue',
    eventDate: new Date(),
    startTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
  });
  const question = await VoteQuestion.create({ eventId: event._id, kind: 'busy', prompt: 'How busy?', order: 0, options: [] });
  return { event, question, vendorId };
}

describe('voteDiscussion.service', () => {
  beforeAll(async () => {
    await connectTestDb();
    await VoteComment.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('posts a top-level comment and a reply, tracking replyCount', async () => {
    const { question } = await seedQuestion();
    const buyer = await mk('+26878600001', 'commenter_a');
    const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };

    const top = await postComment(String(question._id), actor, 'First!');
    expect(top.parentId).toBeNull();

    const other = await mk('+26878600002', 'commenter_b');
    const replier: SocialActor = { type: 'buyer', id: String(other._id) };
    await postComment(String(question._id), replier, 'Agreed', top.id);

    const parent = await VoteComment.findById(top.id);
    expect(parent!.replyCount).toBe(1);
  });

  it('rejects a reply to a reply (one level of nesting only)', async () => {
    const { question } = await seedQuestion();
    const buyer = await mk('+26878600003', 'commenter_c');
    const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
    const top = await postComment(String(question._id), actor, 'Top');
    const reply = await postComment(String(question._id), actor, 'Reply', top.id);
    await expect(postComment(String(question._id), actor, 'Reply to reply', reply.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('toggles a like and reflects it in the comment list', async () => {
    const { question } = await seedQuestion();
    const buyer = await mk('+26878600004', 'commenter_d');
    const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
    const comment = await postComment(String(question._id), actor, 'Like me');

    const on = await reactToComment(comment.id, actor);
    expect(on).toEqual({ active: true, likeCount: 1 });
    const off = await reactToComment(comment.id, actor);
    expect(off).toEqual({ active: false, likeCount: 0 });

    await reactToComment(comment.id, actor);
    const list = await listComments(String(question._id), actor, null);
    expect(list[0]!.viewerHasLiked).toBe(true);
    expect(list[0]!.likeCount).toBe(1);
  });

  it('only the author may delete their own comment; deletion is soft and hides it from listing', async () => {
    const { question } = await seedQuestion();
    const author = await mk('+26878600005', 'commenter_e');
    const other = await mk('+26878600006', 'commenter_f');
    const actor: SocialActor = { type: 'buyer', id: String(author._id) };
    const otherActor: SocialActor = { type: 'buyer', id: String(other._id) };
    const comment = await postComment(String(question._id), actor, 'Mine');

    await expect(deleteOwnComment(comment.id, otherActor)).rejects.toMatchObject({ statusCode: 403 });
    await deleteOwnComment(comment.id, actor);
    expect((await VoteComment.findById(comment.id))!.status).toBe('removed');
    expect(await listComments(String(question._id), actor, null)).toEqual([]);
  });

  it('lets the owning organizer, but not another organizer, moderate-remove a comment', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const { question } = await seedQuestion(vendorId);
    const buyer = await mk('+26878600007', 'commenter_g');
    const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
    const comment = await postComment(String(question._id), actor, 'Inappropriate');

    const otherOrganizer = { vendorId: new mongoose.Types.ObjectId().toString(), isSuperAdmin: false };
    await expect(moderateRemoveComment(comment.id, otherOrganizer)).rejects.toMatchObject({ statusCode: 403 });

    const owningOrganizer = { vendorId: vendorId.toString(), isSuperAdmin: false };
    await moderateRemoveComment(comment.id, owningOrganizer);
    const removed = await VoteComment.findById(comment.id);
    expect(removed!.status).toBe('removed');
    expect(removed!.removedBy).toBe(vendorId.toString());
  });

  it('lets a platform super-admin moderate-remove regardless of ownership', async () => {
    const { question } = await seedQuestion();
    const buyer = await mk('+26878600008', 'commenter_h');
    const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
    const comment = await postComment(String(question._id), actor, 'Spam');

    await moderateRemoveComment(comment.id, { isSuperAdmin: true });
    expect((await VoteComment.findById(comment.id))!.status).toBe('removed');
  });
});
