import { Event } from '@models/event.model';
import { EventQuestion, IEventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import { assertActorNotSuspended, authorDto, loadAuthorMaps, type AuthorMaps } from '@services/socialAuthor.service';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;

function replyDto(reply: any, maps: AuthorMaps) {
  return {
    id: String(reply._id),
    questionId: String(reply.questionId),
    eventId: reply.eventId ? String(reply.eventId) : null,
    body: reply.body,
    createdAt: reply.createdAt,
    author: authorDto(reply.authorType, reply.authorId, maps),
  };
}

/**
 * Hydrate a batch of raw EventQuestion docs into full DTOs: batches reply
 * loading, author loading (questions AND replies together, via
 * loadAuthorMaps), and the viewer's likes into a bounded number of queries
 * regardless of how many questions/replies are in play — no per-row
 * round-trips. Shared by listQuestions (one event) and listRecent (cross-
 * event) so this hydration exists in exactly one place.
 */
async function hydrateQuestions(questions: any[], actor: SocialActor | null): Promise<any[]> {
  if (questions.length === 0) return [];

  const questionIds = questions.map((q) => String(q._id));
  const replies = await EventQuestionReply.find({ questionId: { $in: questionIds } })
    .sort({ createdAt: 1 })
    .lean();

  const authorMaps = await loadAuthorMaps([
    ...questions.map((q) => ({ authorType: q.authorType, authorId: q.authorId })),
    ...replies.map((r) => ({ authorType: r.authorType, authorId: r.authorId })),
  ]);

  const likedQuestionIds = actor
    ? new Set(
        (
          await EventQuestionReaction.find({
            questionId: { $in: questionIds },
            actorType: actor.type,
            buyerId: actor.id,
            type: 'like',
          }).lean()
        ).map((r) => String(r.questionId)),
      )
    : new Set<string>();

  const repliesByQuestion = new Map<string, any[]>();
  for (const r of replies) {
    const key = String(r.questionId);
    if (!repliesByQuestion.has(key)) repliesByQuestion.set(key, []);
    repliesByQuestion.get(key)!.push(r);
  }

  return questions.map((q) => {
    const id = String(q._id);
    return {
      id,
      eventId: q.eventId ? String(q.eventId) : null,
      body: q.body,
      likeCount: q.likeCount,
      replyCount: q.replyCount,
      createdAt: q.createdAt,
      author: authorDto(q.authorType, q.authorId, authorMaps),
      viewerHasLiked: likedQuestionIds.has(id),
      replies: (repliesByQuestion.get(id) ?? []).map((r) => replyDto(r, authorMaps)),
    };
  });
}

/**
 * All questions for an event, newest first, each carrying its replies
 * (oldest first) and viewerHasLiked. See hydrateQuestions for the batching
 * guarantees.
 */
export async function listQuestions(eventId: string, actor: SocialActor | null): Promise<any[]> {
  const questions = await EventQuestion.find({ eventId }).sort({ createdAt: -1 }).lean();
  return hydrateQuestions(questions, actor);
}

/**
 * One question by id, hydrated exactly like the feed rows (author, replies
 * oldest-first, viewerHasLiked) PLUS its owning event {id, name} — powers the
 * standalone topic-detail conversation page (/topic/:id). Returns null when the
 * id doesn't resolve so the controller can 404 rather than 500.
 */
export async function getQuestion(questionId: string, actor: SocialActor | null): Promise<any | null> {
  const question = await EventQuestion.findById(questionId).lean();
  if (!question) return null;
  const [hydrated] = await hydrateQuestions([question], actor);
  if (!question.eventId) return { ...hydrated, event: null };
  const event = await Event.findById(question.eventId).select('name').lean();
  return { ...hydrated, event: { id: String(question.eventId), name: (event as any)?.name ?? null } };
}

/**
 * The most recent questions ACROSS ALL events, newest first — powers the
 * TopicsPage's cross-event discussion list (listQuestions is scoped to one
 * event's Q&A thread). Reuses hydrateQuestions for author/reply/like
 * hydration, then batch-loads the (id, name) of every distinct event the
 * page of questions touches in one extra query — never one Event lookup per
 * question.
 */
export async function listRecent(actor: SocialActor | null, limit = 20): Promise<any[]> {
  const questions = await EventQuestion.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  if (questions.length === 0) return [];

  const hydrated = await hydrateQuestions(questions, actor);

  const eventIds = [...new Set(questions.map((q) => q.eventId).filter(Boolean).map((id) => String(id)))];
  const events = await Event.find({ _id: { $in: eventIds } }).select('name').lean();
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  return hydrated.map((q) => ({
    ...q,
    // Absent for a general "Chat with Everyone" post (no eventId) — that
    // feed deliberately doesn't surface which event a post is about, because
    // it isn't about one. See EveryoneChatPage.
    event: q.eventId ? { id: q.eventId, name: eventMap.get(q.eventId)?.name ?? null } : null,
  }));
}

/**
 * Post a new question. `eventId` scopes it to that event's Q&A thread; pass
 * null for a general "Chat with Everyone" post, which isn't about any one
 * event (see EventQuestionController.createGeneral).
 */
export async function createQuestion(eventId: string | null, actor: SocialActor, body: string): Promise<any> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Question body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Question is too long');
  if (eventId && !(await Event.exists({ _id: eventId }))) throw new HttpError(404, 'Event not found');

  const question: IEventQuestion = await EventQuestion.create({
    ...(eventId ? { eventId } : {}),
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return {
    id: String(question._id),
    eventId: question.eventId ? String(question.eventId) : null,
    body: question.body,
    likeCount: question.likeCount,
    replyCount: question.replyCount,
    createdAt: question.createdAt,
    author: authorDto(actor.type, actor.id, authorMaps),
    viewerHasLiked: false,
    replies: [],
  };
}

/** Post a reply on an existing question, incrementing its replyCount. */
export async function createReply(questionId: string, actor: SocialActor, body: string): Promise<any> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Reply body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Reply is too long');

  const question = await EventQuestion.findById(questionId).select('eventId');
  if (!question) throw new HttpError(404, 'Question not found');

  const reply = await EventQuestionReply.create({
    questionId,
    ...(question.eventId ? { eventId: question.eventId } : {}),
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });
  await EventQuestion.updateOne({ _id: questionId }, { $inc: { replyCount: 1 } });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return replyDto(reply, authorMaps);
}

/** Toggle the actor's like on a question. Mirrors toggleEventLike/toggleReaction. */
export async function toggleQuestionLike(questionId: string, actor: SocialActor): Promise<{ active: boolean; likeCount: number }> {
  await assertActorNotSuspended(actor);
  if (!(await EventQuestion.exists({ _id: questionId }))) throw new HttpError(404, 'Question not found');

  const { active } = await toggleReactionGeneric({
    reactionModel: EventQuestionReaction,
    targetModel: EventQuestion,
    targetField: 'questionId',
    targetId: questionId,
    actor,
    type: 'like',
    counterField: 'likeCount',
  });
  const q = await EventQuestion.findById(questionId).select('likeCount').lean();
  return { active, likeCount: q?.likeCount ?? 0 };
}
