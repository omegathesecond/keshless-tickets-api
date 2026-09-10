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

/** Parsed + validated cursor/limit query params, shared by the buyer and vendor list handlers. */
function parseListQuery(req: Request, res: Response): { cursor?: string; limit?: number } | null {
  const cursor = req.query['cursor'] as string | undefined;
  if (cursor !== undefined && Number.isNaN(Date.parse(cursor))) {
    ApiResponseUtil.error(res, 'cursor must be an ISO date', 400);
    return null;
  }
  const rawLimit = req.query['limit'];
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
      return null;
    }
  }
  return { cursor, limit };
}

export class AccountActivityController {
  /** GET /api/social/me/account-activity — the My Account tab's feed (buyer session). */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const query = parseListQuery(req, res);
      if (!query) return;

      const page = await AccountActivityService.list(String(buyer._id), query);
      return ApiResponseUtil.success(res, page);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load account activity');
    }
  }

  /** POST /api/social/me/account-activity/read { actorType, actorId, kind, targetId? } (buyer session) */
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

  /** POST /api/social/me/account-activity/read-all (buyer session) */
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

  /**
   * GET /api/tickets/social/me/account-activity — the organizer brand's own
   * My Account tab feed. Same AccountActivityService.list an owner-agnostic
   * ownerId already supports (see follow/story/post-view recording, which
   * already credits vendor owners) — only the buyer-only route/controller
   * pair was missing, which is what surfaced as "an error under My Account"
   * for an organizer session (the client hit the buyer-only
   * /api/social/me/account-activity with a vendor token and got 401'd).
   */
  static async listAsVendor(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');

      const query = parseListQuery(req, res);
      if (!query) return;

      const page = await AccountActivityService.list(vendorId, query);
      return ApiResponseUtil.success(res, page);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load account activity');
    }
  }

  /** POST /api/tickets/social/me/account-activity/read (organizer brand session) */
  static async markReadAsVendor(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');

      const group = parseGroupRef(req.body);
      if (!group) return ApiResponseUtil.error(res, 'actorType, actorId and kind are required', 400);

      await AccountActivityService.markRead(vendorId, group);
      return ApiResponseUtil.success(res, { read: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark account activity read');
    }
  }

  /** POST /api/tickets/social/me/account-activity/read-all (organizer brand session) */
  static async markAllReadAsVendor(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');

      await AccountActivityService.markAllRead(vendorId);
      return ApiResponseUtil.success(res, { read: true }, 'Marked all as read');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark account activity read');
    }
  }
}
