import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VoteQuestion } from '@models/voteQuestion.model';
import { VoteResponse } from '@models/voteResponse.model';
import { SongSuggestion } from '@models/songSuggestion.model';
import {
  deriveQuestionDefinitions,
  ensureVoteQuestions,
  getVotePayload,
  castVote,
  suggestSong,
} from '@services/vote.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A published event, `startTime` days from now, published `publishedDaysAgo`
 *  days ago — enough control to hit every branch of the activation window. */
async function seedEvent(opts: { startInDays: number; publishedDaysAgo: number; lineup?: string[]; outfitThemeOptions?: string[]; category?: string }) {
  const now = Date.now();
  const startTime = new Date(now + opts.startInDays * DAY_MS);
  const publishedAt = new Date(now - opts.publishedDaysAgo * DAY_MS);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Vote Test Event',
    venue: 'Test Venue',
    eventDate: startTime,
    startTime,
    endTime: new Date(startTime.getTime() + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    publishedAt,
    lineup: opts.lineup,
    outfitThemeOptions: opts.outfitThemeOptions,
    category: opts.category,
  });
  return event;
}

describe('deriveQuestionDefinitions', () => {
  it('only includes gated questions when the event actually carries their data', () => {
    const bare = deriveQuestionDefinitions({ lineup: undefined, outfitThemeOptions: undefined, category: 'Other' as any });
    expect(bare.map((d) => d.kind)).toEqual(['attending_with', 'busy']);

    const full = deriveQuestionDefinitions({ lineup: ['DJ Nova', 'MC Rae'], outfitThemeOptions: ['White Party', 'Neon'], category: 'Music' as any });
    expect(full.map((d) => d.kind)).toEqual(['artist', 'song', 'outfit', 'attending_with', 'busy']);
    expect(full[0]!.options.map((o) => o.label)).toEqual(['DJ Nova', 'MC Rae']);
  });

  it('includes the song question for a lineup event even outside the Music category', () => {
    const defs = deriveQuestionDefinitions({ lineup: ['DJ Nova'], outfitThemeOptions: undefined, category: 'Other' as any });
    expect(defs.map((d) => d.kind)).toContain('song');
  });
});

describe('vote.service', () => {
  beforeAll(async () => {
    await connectTestDb();
    await VoteQuestion.init();
    await VoteResponse.init();
    await SongSuggestion.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('getVotePayload returns no questions before the window opens', async () => {
    const event = await seedEvent({ startInDays: 20, publishedDaysAgo: 1 }); // opens at T-7d, we're at T-20d
    const payload = await getVotePayload(String(event._id), null);
    expect(payload.window.hasOpened).toBe(false);
    expect(payload.questions).toEqual([]);
    expect(await VoteQuestion.countDocuments({})).toBe(0); // never materialized early
  });

  it('materializes questions once the window opens, and freezes them against later lineup edits', async () => {
    const event = await seedEvent({ startInDays: 5, publishedDaysAgo: 10, lineup: ['DJ Nova'] });
    const payload = await getVotePayload(String(event._id), null);
    expect(payload.window.hasOpened).toBe(true);
    const artistQ = payload.questions.find((q) => q.kind === 'artist')!;
    expect(artistQ.options.map((o) => o.label)).toEqual(['DJ Nova']);

    // Organizer edits the lineup after Vote has opened.
    await Event.updateOne({ _id: event._id }, { lineup: ['DJ Nova', 'DJ New'] });
    const again = await getVotePayload(String(event._id), null);
    const artistQAgain = again.questions.find((q) => q.kind === 'artist')!;
    expect(artistQAgain.options.map((o) => o.label)).toEqual(['DJ Nova']); // unchanged — frozen
    expect(await VoteQuestion.countDocuments({ eventId: event._id, kind: 'artist' })).toBe(1); // no duplicate row
  });

  it('ensureVoteQuestions is idempotent under a concurrent call (unique index absorbs the race)', async () => {
    const event = await seedEvent({ startInDays: 5, publishedDaysAgo: 10 });
    await Promise.all([ensureVoteQuestions(event as any), ensureVoteQuestions(event as any)]);
    const kinds = (await VoteQuestion.find({ eventId: event._id })).map((q) => q.kind);
    expect(new Set(kinds).size).toBe(kinds.length); // no duplicate kind
  });

  it('hides results until the viewer has voted; reveals genuine totals/percentages after', async () => {
    const event = await seedEvent({ startInDays: 3, publishedDaysAgo: 4 });
    const { Buyer } = await import('@models/buyer.model');
    const a = await Buyer.create({ phone: '+26878400001', password: 'secret1', username: 'voter_a' });
    const b = await Buyer.create({ phone: '+26878400002', password: 'secret1', username: 'voter_b' });
    const actorA = { type: 'buyer' as const, id: String(a._id) };
    const actorB = { type: 'buyer' as const, id: String(b._id) };

    const before = await getVotePayload(String(event._id), actorA);
    const busyQ = before.questions.find((q) => q.kind === 'busy')!;
    expect(busyQ.results).toBeNull();
    expect(busyQ.totalVotes).toBe(0);

    await castVote(String(event._id), busyQ.id, actorA, 'packed');
    await castVote(String(event._id), busyQ.id, actorB, 'packed');

    const after = await getVotePayload(String(event._id), actorA);
    const revealed = after.questions.find((q) => q.kind === 'busy')!;
    expect(revealed.viewerHasVoted).toBe(true);
    expect(revealed.viewerSelection).toBe('packed');
    expect(revealed.results!.totalVotes).toBe(2);
    expect(revealed.results!.leadingKey).toBe('packed');
    expect(revealed.results!.options.find((o) => o.key === 'packed')!.percent).toBe(100);
  });

  it('changing a vote overwrites the same row (one vote per question, latest wins)', async () => {
    const event = await seedEvent({ startInDays: 3, publishedDaysAgo: 4 });
    const { Buyer } = await import('@models/buyer.model');
    const a = await Buyer.create({ phone: '+26878400003', password: 'secret1', username: 'voter_c' });
    const actor = { type: 'buyer' as const, id: String(a._id) };
    const payload = await getVotePayload(String(event._id), actor);
    const busyQ = payload.questions.find((q) => q.kind === 'busy')!;

    await castVote(String(event._id), busyQ.id, actor, 'packed');
    await castVote(String(event._id), busyQ.id, actor, 'quiet');
    // Duplicate tap of the same final choice must not create a second row either.
    await castVote(String(event._id), busyQ.id, actor, 'quiet');

    expect(await VoteResponse.countDocuments({ questionId: busyQ.id })).toBe(1);
    const row = await VoteResponse.findOne({ questionId: busyQ.id });
    expect(row!.optionKey).toBe('quiet');
  });

  it('rejects a vote before the window opens and after it closes', async () => {
    const { Buyer } = await import('@models/buyer.model');
    const a = await Buyer.create({ phone: '+26878400004', password: 'secret1', username: 'voter_d' });
    const actor = { type: 'buyer' as const, id: String(a._id) };

    const notYet = await seedEvent({ startInDays: 20, publishedDaysAgo: 1 });
    // Force-materialize a question directly (bypassing the not-yet-open payload gate) to isolate castVote's own window check.
    const [q] = await ensureVoteQuestions(notYet as any);
    await expect(castVote(String(notYet._id), String(q!._id), actor, 'packed')).rejects.toMatchObject({ statusCode: 409 });

    const closed = await seedEvent({ startInDays: -1, publishedDaysAgo: 10 });
    const [q2] = await ensureVoteQuestions(closed as any);
    await expect(castVote(String(closed._id), String(q2!._id), actor, 'packed')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an option key that is not one of the question\'s options', async () => {
    const event = await seedEvent({ startInDays: 3, publishedDaysAgo: 4 });
    const { Buyer } = await import('@models/buyer.model');
    const a = await Buyer.create({ phone: '+26878400005', password: 'secret1', username: 'voter_e' });
    const actor = { type: 'buyer' as const, id: String(a._id) };
    const payload = await getVotePayload(String(event._id), actor);
    const busyQ = payload.questions.find((q) => q.kind === 'busy')!;
    await expect(castVote(String(event._id), busyQ.id, actor, 'not-a-real-option')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('suggestSong dedupes near-identical suggestions and votes the suggester onto the existing one', async () => {
    const event = await seedEvent({ startInDays: 3, publishedDaysAgo: 4, category: 'Music' });
    const { Buyer } = await import('@models/buyer.model');
    const a = await Buyer.create({ phone: '+26878400006', password: 'secret1', username: 'voter_f' });
    const b = await Buyer.create({ phone: '+26878400007', password: 'secret1', username: 'voter_g' });
    const actorA = { type: 'buyer' as const, id: String(a._id) };
    const actorB = { type: 'buyer' as const, id: String(b._id) };

    const payload = await getVotePayload(String(event._id), actorA);
    const songQ = payload.questions.find((q) => q.kind === 'song')!;

    await suggestSong(String(event._id), songQ.id, actorA, '  Jerusalema  ', 'Master KG');
    await suggestSong(String(event._id), songQ.id, actorB, 'jerusalema', 'master kg'); // same song, different casing/spacing

    expect(await SongSuggestion.countDocuments({ questionId: songQ.id })).toBe(1);
    expect(await VoteResponse.countDocuments({ questionId: songQ.id })).toBe(2); // both auto-voted

    const revealed = await getVotePayload(String(event._id), actorA);
    const songQAfter = revealed.questions.find((q) => q.kind === 'song')!;
    expect(songQAfter.suggestions![0]!.count).toBe(2);
  });

  it('surfaces only CONFIRMED attendee tags publicly, and only once results are revealed', async () => {
    const { VoteTagService } = await import('@services/voteTag.service');
    const event = await seedEvent({ startInDays: 3, publishedDaysAgo: 4 });
    const { Buyer } = await import('@models/buyer.model');
    const tagger = await Buyer.create({ phone: '+26878400008', password: 'secret1', username: 'tagger_h' });
    const confirmedTarget = await Buyer.create({ phone: '+26878400009', password: 'secret1', username: 'confirmed_h' });
    const pendingTarget = await Buyer.create({ phone: '+26878400010', password: 'secret1', username: 'pending_h' });
    const voter = { type: 'buyer' as const, id: String(tagger._id) };

    const before = await getVotePayload(String(event._id), voter);
    const attendingQ = before.questions.find((q) => q.kind === 'attending_with')!;
    expect(attendingQ.confirmedTags).toBeUndefined(); // not revealed yet — viewer hasn't voted

    const confirmedTag = await VoteTagService.request(tagger, attendingQ.id, String(confirmedTarget._id));
    await VoteTagService.request(tagger, attendingQ.id, String(pendingTarget._id));
    await VoteTagService.confirm(confirmedTarget, String(confirmedTag._id));

    await castVote(String(event._id), attendingQ.id, voter, 'solo');
    const after = await getVotePayload(String(event._id), voter);
    const revealedQ = after.questions.find((q) => q.kind === 'attending_with')!;
    expect(revealedQ.confirmedTags).toHaveLength(1);
    expect(revealedQ.confirmedTags![0]!.tagger.username).toBe('tagger_h');
    expect(revealedQ.confirmedTags![0]!.taggedUser.username).toBe('confirmed_h');
  });
});
