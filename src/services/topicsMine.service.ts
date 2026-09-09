import { Event } from '@models/event.model';
import { EventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';
import { EventQuestionRead } from '@models/eventQuestionRead.model';
import { HttpError } from '@utils/httpError.util';
import { loadAuthorMaps, authorDto } from '@services/socialAuthor.service';
import { loadMembershipInfo, type QuestionMemberInfo } from '@services/eventQuestion.service';
import type { SocialActor } from '@utils/socialActor.util';

/**
 * "YOUR TOPICS" — the topics (event Q&A questions) an actor started OR replied
 * to, newest-activity first, each carrying its event {id, name, image} and an
 * `unreadCount` of replies the actor hasn't seen.
 *
 * Deliberately a NEW module rather than another export on eventQuestion.service:
 * it needs none of that file's private helpers (author/reply hydration is the
 * shared socialAuthor.service), and keeping it separate avoids colliding with
 * concurrent work there. The DTO is the cross-event `Question` shape the
 * TopicsPage already renders, plus `event.image` and `unreadCount`.
 */

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function isActorReply(reply: { authorType: string; authorId: unknown }, actor: SocialActor): boolean {
  return reply.authorType === actor.type && String(reply.authorId) === String(actor.id);
}

export async function listMine(actor: SocialActor, limit = DEFAULT_LIMIT): Promise<any[]> {
  const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);

  // The union of "questions I authored" and "questions I replied to". Both are
  // indexed lookups on (authorType, authorId); the reply side is collapsed to
  // distinct questionIds so a thread I answered ten times counts once.
  const [authored, repliedIds] = await Promise.all([
    EventQuestion.find({ authorType: actor.type, authorId: actor.id }).select('_id').lean(),
    EventQuestionReply.find({ authorType: actor.type, authorId: actor.id }).distinct('questionId'),
  ]);

  const ids = [...new Set([...authored.map((q) => String(q._id)), ...repliedIds.map((id) => String(id))])];
  if (ids.length === 0) return [];

  // updatedAt bumps on every replyCount $inc, so it tracks last activity —
  // the newest-first order the design shows.
  const questions = await EventQuestion.find({ _id: { $in: ids } })
    .sort({ updatedAt: -1 })
    .limit(capped)
    .lean();

  const questionIds = questions.map((q) => String(q._id));

  const [replies, likedRows, reads, events, memberInfo] = await Promise.all([
    EventQuestionReply.find({ questionId: { $in: questionIds } }).sort({ createdAt: 1 }).lean(),
    EventQuestionReaction.find({ questionId: { $in: questionIds }, actorType: actor.type, buyerId: actor.id, type: 'like' })
      .select('questionId')
      .lean(),
    EventQuestionRead.find({ actorType: actor.type, actorId: actor.id, questionId: { $in: questionIds } })
      .select('questionId lastViewedAt')
      .lean(),
    Event.find({ _id: { $in: [...new Set(questions.map((q) => q.eventId).filter(Boolean).map((id) => String(id)))] } })
      .select('name posterUrl thumbnailUrl')
      .lean(),
    loadMembershipInfo(questionIds, actor),
  ]);

  const authorMaps = await loadAuthorMaps([
    ...questions.map((q) => ({ authorType: q.authorType, authorId: q.authorId })),
    ...replies.map((r) => ({ authorType: r.authorType, authorId: r.authorId })),
  ]);

  const likedIds = new Set(likedRows.map((r) => String(r.questionId)));
  const lastViewed = new Map(reads.map((r: any) => [String(r.questionId), r.lastViewedAt as Date]));
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  const repliesByQuestion = new Map<string, any[]>();
  for (const r of replies) {
    const key = String(r.questionId);
    if (!repliesByQuestion.has(key)) repliesByQuestion.set(key, []);
    repliesByQuestion.get(key)!.push(r);
  }

  return questions.map((q) => {
    const id = String(q._id);
    const qReplies = repliesByQuestion.get(id) ?? [];
    const seenAt = lastViewed.get(id);
    // Unread = replies by SOMEONE ELSE newer than my cursor. A thread I've
    // never opened (no cursor) counts every other author's reply; my own
    // replies never count, so answering a topic can't make it look unread.
    const unreadCount = qReplies.filter((r) => !isActorReply(r, actor) && (!seenAt || r.createdAt > seenAt)).length;
    const ev = q.eventId ? eventMap.get(String(q.eventId)) : null;

    return {
      id,
      eventId: q.eventId ? String(q.eventId) : null,
      body: q.body,
      likeCount: q.likeCount,
      replyCount: q.replyCount,
      createdAt: q.createdAt,
      author: authorDto(q.authorType, q.authorId, authorMaps),
      viewerHasLiked: likedIds.has(id),
      replies: qReplies.map((r) => ({
        id: String(r._id),
        body: r.body,
        createdAt: r.createdAt,
        author: authorDto(r.authorType, r.authorId, authorMaps),
      })),
      unreadCount,
      // Absent for a general "Chat with Everyone" post — it isn't about an event.
      event: q.eventId ? { id: String(q.eventId), name: ev?.name ?? null, image: ev?.thumbnailUrl ?? ev?.posterUrl ?? null } : null,
      ...(memberInfo.get(id) ?? ({ memberCount: 0, members: [], viewerIsMember: false } as QuestionMemberInfo)),
    };
  });
}

/**
 * Mark a topic as read for this actor — bumps (or creates) their read cursor
 * to now, zeroing its unread badge. Idempotent; upsert keyed on the unique
 * (actor, question) index.
 */
export async function markRead(questionId: string, actor: SocialActor): Promise<{ ok: true }> {
  if (!(await EventQuestion.exists({ _id: questionId }))) throw new HttpError(404, 'Group chat not found');
  await EventQuestionRead.updateOne(
    { actorType: actor.type, actorId: actor.id, questionId },
    { $set: { lastViewedAt: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}
