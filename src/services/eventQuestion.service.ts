import { Event } from '@models/event.model';
import { EventQuestion, IEventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';
import { EventQuestionMember } from '@models/eventQuestionMember.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import { assertActorNotSuspended, authorDto, loadAuthorMaps, type AuthorDTO, type AuthorMaps } from '@services/socialAuthor.service';
import { HttpError } from '@utils/httpError.util';
import { isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;
const MAX_PREVIEW_MEMBERS = 4;
/** Mongo's duplicate-key error code — a racing double-tap on Join both losing
 *  the findOne check and hitting the unique index is expected, not a bug. */
const DUPLICATE_KEY_CODE = 11000;

export interface QuestionMemberInfo {
  memberCount: number;
  /** Most-recently-joined first, capped at MAX_PREVIEW_MEMBERS — the avatars a
   *  topic card/detail page actually renders. */
  members: AuthorDTO[];
  viewerIsMember: boolean;
}

const EMPTY_MEMBER_INFO: QuestionMemberInfo = { memberCount: 0, members: [], viewerIsMember: false };

/**
 * Batch-load membership info (count, preview avatars, viewer's own state) for
 * a set of questions in a bounded number of queries — the same batching
 * discipline as hydrateQuestions' author/reply/like loading. Shared by
 * hydrateQuestions and topicsMine.service so "who's joined this topic" reads
 * identically everywhere.
 */
export async function loadMembershipInfo(
  questionIds: string[],
  actor: SocialActor | null,
): Promise<Map<string, QuestionMemberInfo>> {
  const result = new Map<string, QuestionMemberInfo>();
  if (questionIds.length === 0) return result;

  const rows = await EventQuestionMember.find({ questionId: { $in: questionIds } })
    .sort({ createdAt: -1 })
    .lean();

  const byQuestion = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = String(r.questionId);
    if (!byQuestion.has(key)) byQuestion.set(key, []);
    byQuestion.get(key)!.push(r);
  }

  const authorMaps = await loadAuthorMaps(rows.map((r) => ({ authorType: r.actorType, authorId: r.buyerId })));

  for (const id of questionIds) {
    const memberRows = byQuestion.get(id) ?? [];
    const viewerIsMember = actor
      ? memberRows.some((r) => r.actorType === actor.type && String(r.buyerId) === String(actor.id))
      : false;
    result.set(id, {
      memberCount: memberRows.length,
      members: memberRows.slice(0, MAX_PREVIEW_MEMBERS).map((r) => authorDto(r.actorType, r.buyerId, authorMaps)),
      viewerIsMember,
    });
  }
  return result;
}

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

  const memberInfo = await loadMembershipInfo(questionIds, actor);

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
      ...(memberInfo.get(id) ?? EMPTY_MEMBER_INFO),
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
  const event = await Event.findById(question.eventId).select('name posterUrl thumbnailUrl').lean();
  const ev = event as any;
  return {
    ...hydrated,
    event: { id: String(question.eventId), name: ev?.name ?? null, image: ev?.thumbnailUrl ?? ev?.posterUrl ?? null },
  };
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
  const events = await Event.find({ _id: { $in: eventIds } }).select('name posterUrl thumbnailUrl').lean();
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  return hydrated.map((q) => {
    const ev = q.eventId ? eventMap.get(q.eventId) : null;
    return {
      ...q,
      // Absent for a general "Chat with Everyone" post (no eventId) — that
      // feed deliberately doesn't surface which event a post is about, because
      // it isn't about one. See EveryoneChatPage.
      event: q.eventId ? { id: q.eventId, name: ev?.name ?? null, image: ev?.thumbnailUrl ?? ev?.posterUrl ?? null } : null,
    };
  });
}

/**
 * The most recent GENERAL posts (no event) — powers "Chat with Everyone"
 * (EveryoneChatPage), which deliberately shows ONLY general posts so it
 * never surfaces an event, keeping event-specific discussion inside each
 * event's own chat. Sibling of listRecent, which is cross-event (event +
 * general mixed) and powers TopicsPage's Topics section instead.
 */
export async function listRecentGeneral(actor: SocialActor | null, limit = 20): Promise<any[]> {
  const questions = await EventQuestion.find({ eventId: { $exists: false } }).sort({ createdAt: -1 }).limit(limit).lean();
  const hydrated = await hydrateQuestions(questions, actor);
  return hydrated.map((q) => ({ ...q, event: null }));
}

/**
 * "Chat with Everyone" member preview for the TopicsPage entry card — the
 * distinct set of actors who have joined ANY general (no-event) topic, most
 * recently joined first, real avatars/counts only (no fabricated numbers).
 * Reads EventQuestionMember directly via its denormalized eventId, so this
 * never needs to join through EventQuestion.
 */
export async function getGeneralChatSummary(): Promise<{ memberCount: number; members: AuthorDTO[] }> {
  const grouped = await EventQuestionMember.aggregate([
    { $match: { eventId: { $exists: false } } },
    { $group: { _id: { actorType: '$actorType', buyerId: '$buyerId' }, joinedAt: { $max: '$createdAt' } } },
    { $sort: { joinedAt: -1 } },
  ]);

  const authorMaps = await loadAuthorMaps(grouped.map((g) => ({ authorType: g._id.actorType, authorId: g._id.buyerId })));
  return {
    memberCount: grouped.length,
    members: grouped.slice(0, MAX_PREVIEW_MEMBERS).map((g) => authorDto(g._id.actorType, g._id.buyerId, authorMaps)),
  };
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

  // The creator is trivially a member of their own topic — a fresh insert can
  // never collide with the unique (questionId, actorType, buyerId) index, so
  // any failure here is real and should surface with the rest of the create.
  await EventQuestionMember.create({
    questionId: question._id,
    ...(question.eventId ? { eventId: question.eventId } : {}),
    actorType: actor.type,
    buyerId: actor.id,
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
    memberCount: 1,
    members: [authorDto(actor.type, actor.id, authorMaps)],
    viewerIsMember: true,
  };
}

/**
 * A topic's own author is always treated as a member — even for a topic
 * created before this feature shipped and so has no EventQuestionMember row —
 * so a legacy author isn't locked out of their own thread. Everyone else must
 * have explicitly joined (see joinQuestion) before they may reply or react.
 */
async function requireMembership(question: { authorType: string; authorId: unknown; _id: unknown }, actor: SocialActor): Promise<void> {
  if (isActorAuthorOf(question.authorType, question.authorId, actor)) return;
  const isMember = await EventQuestionMember.exists({ questionId: question._id, actorType: actor.type, buyerId: actor.id });
  if (!isMember) throw new HttpError(403, 'Join this topic to participate in the conversation.');
}

/** Post a reply on an existing question, incrementing its replyCount. */
export async function createReply(questionId: string, actor: SocialActor, body: string): Promise<any> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Reply body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Reply is too long');

  const question = await EventQuestion.findById(questionId).select('eventId authorType authorId');
  if (!question) throw new HttpError(404, 'Question not found');
  await requireMembership(question, actor);

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
  const question = await EventQuestion.findById(questionId).select('authorType authorId');
  if (!question) throw new HttpError(404, 'Question not found');
  await requireMembership(question, actor);

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

/**
 * Join a topic — idempotent: a repeated tap (or a race between two) never
 * creates a duplicate row, it just re-reads the current state. Required
 * before replying/reacting (see requireMembership) and before My Chats will
 * offer a Leave option.
 */
export async function joinQuestion(questionId: string, actor: SocialActor): Promise<QuestionMemberInfo> {
  await assertActorNotSuspended(actor);
  const question = await EventQuestion.findById(questionId).select('eventId');
  if (!question) throw new HttpError(404, 'Topic not found');

  try {
    await EventQuestionMember.create({
      questionId,
      ...(question.eventId ? { eventId: question.eventId } : {}),
      actorType: actor.type,
      buyerId: actor.id,
    });
  } catch (err: any) {
    if (err?.code !== DUPLICATE_KEY_CODE) throw err; // already a member — join is idempotent
  }

  return (await loadMembershipInfo([questionId], actor)).get(questionId) ?? EMPTY_MEMBER_INFO;
}

/** Leave a previously-joined topic. Idempotent — leaving twice is a no-op. */
export async function leaveQuestion(questionId: string, actor: SocialActor): Promise<QuestionMemberInfo> {
  if (!(await EventQuestion.exists({ _id: questionId }))) throw new HttpError(404, 'Topic not found');
  await EventQuestionMember.deleteOne({ questionId, actorType: actor.type, buyerId: actor.id });
  return (await loadMembershipInfo([questionId], actor)).get(questionId) ?? EMPTY_MEMBER_INFO;
}
