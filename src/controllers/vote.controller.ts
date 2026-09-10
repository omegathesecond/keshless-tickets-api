import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { getVotePayload, castVote, suggestSong } from '@services/vote.service';
import { VoteTagService } from '@services/voteTag.service';
import { listComments, postComment, reactToComment, deleteOwnComment, moderateRemoveComment } from '@services/voteDiscussion.service';

/** Buyer/public-facing Vote endpoints — event-detail page (spec §3) + Home
 *  feed cards (spec §4) + voting/song-suggestion/attendee-tag/discussion
 *  writes (spec §5, §2, §7). Mirrors EventQuestionController's shape:
 *  optionalTicketsAuth reads degrade to an anonymous view; writes 401
 *  outright when no actor resolves. */
export class VoteController {
  /** GET /api/public/events/:eventId/vote */
  static async get(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      return ApiResponseUtil.success(res, await getVotePayload(req.params['eventId'] as string, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Vote');
    }
  }

  /** POST /api/public/events/:eventId/vote/:questionId { optionKey } */
  static async cast(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to vote');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const view = await castVote(req.params['eventId'] as string, req.params['questionId'] as string, actor, req.body?.optionKey);
      return ApiResponseUtil.success(res, view, 'Vote recorded');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to record vote');
    }
  }

  /** POST /api/public/events/:eventId/vote/:questionId/songs { title, artist? } */
  static async suggestSong(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to suggest a song');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const view = await suggestSong(req.params['eventId'] as string, req.params['questionId'] as string, actor, req.body?.title, req.body?.artist);
      return ApiResponseUtil.created(res, view, 'Song suggested');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to suggest song');
    }
  }

  /** POST /api/public/events/:eventId/vote/:questionId/tags { targetUserId } */
  static async requestTag(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to tag someone');
      const tag = await VoteTagService.request(buyer, req.params['questionId'] as string, String(req.body?.targetUserId || ''));
      return ApiResponseUtil.created(res, { id: String(tag._id), status: tag.status }, 'Tag sent');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to tag attendee');
    }
  }

  /** POST /api/public/vote-tags/:tagId/confirm */
  static async confirmTag(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await VoteTagService.confirm(buyer, req.params['tagId'] as string);
      return ApiResponseUtil.success(res, { status: 'confirmed' }, 'Tag confirmed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to confirm tag');
    }
  }

  /** POST /api/public/vote-tags/:tagId/decline */
  static async declineTag(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await VoteTagService.decline(buyer, req.params['tagId'] as string);
      return ApiResponseUtil.success(res, { status: 'declined' }, 'Tag declined');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to decline tag');
    }
  }

  /** DELETE /api/public/vote-tags/:tagId */
  static async removeTag(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await VoteTagService.remove(buyer, req.params['tagId'] as string);
      return ApiResponseUtil.success(res, { removed: true }, 'Tag removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove tag');
    }
  }

  /** GET /api/public/vote-questions/:questionId/comments */
  static async listComments(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      const comments = await listComments(req.params['questionId'] as string, actor, (req as any).ticketsUser);
      return ApiResponseUtil.success(res, { comments });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load discussion');
    }
  }

  /** POST /api/public/vote-questions/:questionId/comments { body, parentId? } */
  static async postComment(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const comment = await postComment(req.params['questionId'] as string, actor, req.body?.body, req.body?.parentId);
      return ApiResponseUtil.created(res, comment);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post comment');
    }
  }

  /** POST /api/public/vote-comments/:commentId/react */
  static async reactToComment(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      return ApiResponseUtil.success(res, await reactToComment(req.params['commentId'] as string, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to react to comment');
    }
  }

  /** DELETE /api/public/vote-comments/:commentId — own comment only. */
  static async deleteComment(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await deleteOwnComment(req.params['commentId'] as string, actor);
      return ApiResponseUtil.success(res, { removed: true }, 'Comment deleted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete comment');
    }
  }

  /** DELETE /api/tickets/vote-comments/:commentId/moderate — organizer/platform moderation. */
  static async moderateRemoveComment(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      await moderateRemoveComment(req.params['commentId'] as string, ticketsUser);
      return ApiResponseUtil.success(res, { removed: true }, 'Comment removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove comment');
    }
  }
}
