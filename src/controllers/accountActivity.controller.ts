import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { AccountActivityService } from '@services/accountActivity.service';
import type { AccountActivityKind } from '@models/accountActivityEvent.model';

const KINDS: AccountActivityKind[] = ['profile_view', 'story_view', 'post_view', 'unfollow'];

/** Body/param shape shared by mark-one-read: identifies a group exactly the
 *  way AccountActivityService.list keys it (kind + actor + optional target). */
function parseGroupRef(body: any): { actorType: string; actorId: string; kind: AccountActivityKind; targetId?: string } | null {
  const { actorType, actorId, kind, targetId } = body ?? {};
  if (actorType !== 'buyer' && actorType !== 'vendor') return null;
  if (typeof actorId !== 'string' || !/^[0-9a-f]{24}$/i.test(actorId)) return null;
  if (!KINDS.includes(kind)) return null;
  if (targetId !== undefined && (typeof targetId !== 'string' || !/^[0-9a-f]{24}$/i.test(targetId))) return null;
  return { actorType, actorId, kind, targetId };
}

export class AccountActivityController {
  /** GET /api/social/me/account-activity — the My Account tab's feed. */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const cursor = req.query['cursor'] as string | undefined;
      if (cursor !== undefined && Number.isNaN(Date.parse(cursor))) {
        return ApiResponseUtil.error(res, 'cursor must be an ISO date', 400);
      }
      const rawLimit = req.query['limit'];
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
      }

      const page = await AccountActivityService.list(String(buyer._id), { cursor, limit });
      return ApiResponseUtil.success(res, page);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load account activity');
    }
  }

  /** POST /api/social/me/account-activity/read { actorType, actorId, kind, targetId? } */
  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const group = parseGroupRef(req.body);
      if (!group) return ApiResponseUtil.error(res, 'actorType, actorId and kind are required', 400);

      await AccountActivityService.markRead(String(buyer._id), group);
      return ApiResponseUtil.success(res, { read: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark account activity read');
    }
  }

  /** POST /api/social/me/account-activity/read-all */
  static async markAllRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      await AccountActivityService.markAllRead(String(buyer._id));
      return ApiResponseUtil.success(res, { read: true }, 'Marked all as read');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark account activity read');
    }
  }
}
