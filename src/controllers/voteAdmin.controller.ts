import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { previewVote, getOrganizerSummary } from '@services/vote.service';
import { listComments, moderateRemoveComment } from '@services/voteDiscussion.service';

/** Organizer dashboard §9 — preview, stats/results/song-suggestions, and
 *  discussion moderation for one owned event's Vote. Event-scoped, owner-
 *  checked (or super-admin) inside the service layer, matching the
 *  `/events/:eventId/...` admin routes elsewhere in tickets.route.ts. */
export class VoteAdminController {
  /** GET /api/tickets/events/:eventId/vote/preview */
  static async preview(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const preview = await previewVote(req.params['eventId'] as string, ticketsUser.vendorId, !!ticketsUser.isSuperAdmin);
      return ApiResponseUtil.success(res, preview);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Attendance Status preview');
    }
  }

  /** GET /api/tickets/events/:eventId/vote/summary */
  static async summary(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const summary = await getOrganizerSummary(req.params['eventId'] as string, ticketsUser.vendorId, !!ticketsUser.isSuperAdmin);
      return ApiResponseUtil.success(res, summary);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Response Results');
    }
  }

  /** GET /api/tickets/vote-questions/:questionId/comments — moderation view
   *  (same read as the public one, but always includes viewerCanModerate). */
  static async comments(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const comments = await listComments(req.params['questionId'] as string, null, ticketsUser);
      return ApiResponseUtil.success(res, { comments });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load discussion');
    }
  }

  /** DELETE /api/tickets/vote-comments/:commentId */
  static async removeComment(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      await moderateRemoveComment(req.params['commentId'] as string, ticketsUser);
      return ApiResponseUtil.success(res, { removed: true }, 'Comment removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove comment');
    }
  }
}
