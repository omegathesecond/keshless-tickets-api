import { VoteComment, IVoteComment } from '@models/voteComment.model';
import { VoteCommentReaction } from '@models/voteCommentReaction.model';
import { VoteQuestion } from '@models/voteQuestion.model';
import { Event } from '@models/event.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import { assertActorNotSuspended, authorDto, loadAuthorMaps, type AuthorMaps } from '@services/socialAuthor.service';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import type { SocialActor } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;

interface CommentDto {
  id: string;
  eventId: string;
  questionId: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  replyCount: number;
  createdAt: Date;
  author: ReturnType<typeof authorDto>;
  viewerHasLiked: boolean;
  viewerIsAuthor: boolean;
  viewerCanModerate: boolean;
  replies: CommentDto[];
}

function commentDto(
  c: any,
  maps: AuthorMaps,
  viewer: { actor: SocialActor | null; likedIds: Set<string>; canModerate: boolean },
  replies: any[] = []
): CommentDto {
  const id = String(c._id);
  return {
    id,
    eventId: String(c.eventId),
    questionId: String(c.questionId),
    parentId: c.parentId ? String(c.parentId) : null,
    body: c.body,
    likeCount: c.likeCount ?? 0,
    replyCount: c.replyCount ?? 0,
    createdAt: c.createdAt,
    author: authorDto(c.authorType, c.authorId, maps),
    viewerHasLiked: viewer.likedIds.has(id),
    viewerIsAuthor: !!viewer.actor && c.authorType === viewer.actor.type && String(c.authorId) === String(viewer.actor.id),
    viewerCanModerate: viewer.canModerate,
    replies: replies.map((r) => commentDto(r, maps, viewer)),
  };
}

/** Is `ticketsUser` allowed to moderate this event's Vote discussion — the
 *  event's own organizer, or a platform super-admin. Mirrors
 *  ModerationController.requireCommunityOwnership's ownership rule. */
async function canModerate(eventId: string, ticketsUser: any): Promise<boolean> {
  if (!ticketsUser) return false;
  if (ticketsUser.isSuperAdmin) return true;
  if (!ticketsUser.vendorId) return false;
  const event = await Event.findById(eventId).select('vendorId').lean();
  return !!event && String((event as any).vendorId) === String(ticketsUser.vendorId);
}

/** All active top-level comments + their active replies for one Vote
 *  question, newest-first, hydrated with author/like/moderation state. */
export async function listComments(questionId: string, actor: SocialActor | null, ticketsUser: any): Promise<any[]> {
  if (!HEX24.test(questionId)) throw new HttpError(400, 'Invalid question id');
  const question = await VoteQuestion.findById(questionId).select('eventId');
  if (!question) throw new HttpError(404, 'Question not found');

  const [tops, moderator] = await Promise.all([
    VoteComment.find({ questionId, parentId: null, status: 'active' }).sort({ createdAt: -1 }).lean(),
    canModerate(String(question.eventId), ticketsUser),
  ]);
  if (tops.length === 0) return [];

  const topIds = tops.map((t: any) => String(t._id));
  const replies = await VoteComment.find({ parentId: { $in: topIds }, status: 'active' }).sort({ createdAt: 1 }).lean();

  const authorMaps = await loadAuthorMaps([...tops, ...replies].map((c: any) => ({ authorType: c.authorType, authorId: c.authorId })));

  const allIds = [...topIds, ...replies.map((r: any) => String(r._id))];
  const likedIds = actor
    ? new Set(
        (await VoteCommentReaction.find({ commentId: { $in: allIds }, actorType: actor.type, buyerId: actor.id, type: 'like' }).lean()).map((r: any) =>
          String(r.commentId)
        )
      )
    : new Set<string>();

  const repliesByParent = new Map<string, any[]>();
  for (const r of replies) {
    const key = String((r as any).parentId);
    if (!repliesByParent.has(key)) repliesByParent.set(key, []);
    repliesByParent.get(key)!.push(r);
  }

  const viewer = { actor, likedIds, canModerate: moderator };
  return tops.map((t: any) => commentDto(t, authorMaps, viewer, repliesByParent.get(String(t._id)) ?? []));
}

/** Post a top-level comment, or a reply when `parentId` is given (one level
 *  of nesting — spec §7 asks for "reply to comments", not reply-to-reply). */
export async function postComment(questionId: string, actor: SocialActor, body: string, parentId?: string): Promise<any> {
  await assertActorNotSuspended(actor);
  if (!HEX24.test(questionId)) throw new HttpError(400, 'Invalid question id');
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Comment body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Comment is too long');

  const question = await VoteQuestion.findById(questionId).select('eventId');
  if (!question) throw new HttpError(404, 'Question not found');

  let parent: IVoteComment | null = null;
  if (parentId) {
    if (!HEX24.test(parentId)) throw new HttpError(400, 'Invalid parent comment id');
    parent = await VoteComment.findOne({ _id: parentId, questionId, status: 'active' });
    if (!parent) throw new HttpError(404, 'Comment being replied to was not found');
    if (parent.parentId) throw new HttpError(400, 'Cannot reply to a reply');
  }

  const comment = await VoteComment.create({
    eventId: question.eventId,
    questionId,
    parentId: parent ? parent._id : undefined,
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });
  if (parent) await VoteComment.updateOne({ _id: parent._id }, { $inc: { replyCount: 1 } });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return commentDto(comment, authorMaps, { actor, likedIds: new Set(), canModerate: false });
}

/** Toggle the actor's like on a comment. */
export async function reactToComment(commentId: string, actor: SocialActor): Promise<{ active: boolean; likeCount: number }> {
  await assertActorNotSuspended(actor);
  if (!HEX24.test(commentId)) throw new HttpError(400, 'Invalid comment id');
  if (!(await VoteComment.exists({ _id: commentId, status: 'active' }))) throw new HttpError(404, 'Comment not found');

  const { active } = await toggleReactionGeneric({
    reactionModel: VoteCommentReaction,
    targetModel: VoteComment,
    targetField: 'commentId',
    targetId: commentId,
    actor,
    type: 'like',
    counterField: 'likeCount',
  });
  const c = await VoteComment.findById(commentId).select('likeCount').lean();
  return { active, likeCount: (c as any)?.likeCount ?? 0 };
}

/** "Delete their own comments" (spec §7). */
export async function deleteOwnComment(commentId: string, actor: SocialActor): Promise<void> {
  if (!HEX24.test(commentId)) throw new HttpError(400, 'Invalid comment id');
  const comment = await VoteComment.findById(commentId);
  if (!comment || comment.status === 'removed') return; // idempotent
  if (comment.authorType !== actor.type || String(comment.authorId) !== String(actor.id)) {
    throw new HttpError(403, 'Not your comment to delete');
  }
  comment.status = 'removed';
  await comment.save();
}

/** "The event organizer and platform moderators must be able to remove
 *  inappropriate content" (spec §7). `removedBy` is the ticketsUser's vendor
 *  id, or 'platform' for a superadmin acting outside their own event. */
export async function moderateRemoveComment(commentId: string, ticketsUser: any): Promise<void> {
  if (!HEX24.test(commentId)) throw new HttpError(400, 'Invalid comment id');
  const comment = await VoteComment.findById(commentId);
  if (!comment) throw new HttpError(404, 'Comment not found');
  if (comment.status === 'removed') return;
  if (!(await canModerate(String(comment.eventId), ticketsUser))) {
    throw new HttpError(403, "You cannot moderate this event's Attendance Status discussion");
  }
  comment.status = 'removed';
  comment.removedBy = ticketsUser.isSuperAdmin && !ticketsUser.vendorId ? 'platform' : String(ticketsUser.vendorId);
  await comment.save();
}
