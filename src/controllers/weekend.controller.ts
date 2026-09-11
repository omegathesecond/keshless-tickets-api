import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { WeekendService } from '@services/weekend.service';

const FEED_LIMIT_DEFAULT = 10;
const FEED_LIMIT_MAX = 24;

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT_DEFAULT;
  return Math.min(FEED_LIMIT_MAX, Math.floor(n));
}

function parseExcludeIds(raw: unknown): string[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class WeekendController {
  /** GET /api/social/weekend/me */
  static async getMine(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const status = await WeekendService.getOwnStatus(buyer);
      return ApiResponseUtil.success(res, { status });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load your weekend status');
    }
  }

  /** PUT /api/social/weekend/me */
  static async upsertMine(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const status = await WeekendService.upsertStatus(buyer, req.body || {});
      return ApiResponseUtil.success(res, { status }, 'Weekend status updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update your weekend status');
    }
  }

  /** DELETE /api/social/weekend/me */
  static async removeMine(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await WeekendService.removeStatus(buyer);
      return ApiResponseUtil.success(res, { ok: true }, 'Weekend status removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove your weekend status');
    }
  }

  /** GET /api/social/weekend/users/:username */
  static async getForUser(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await resolveBuyerFromRequest(req);
      const result = await WeekendService.getForViewer(viewer, String(req.params['username'] || ''));
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load weekend status');
    }
  }

  /** GET /api/social/weekend/feed — "Who Has Plans This Weekend" */
  static async feed(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await resolveBuyerFromRequest(req);
      const cards = await WeekendService.getWhoHasPlansCards(viewer, parseLimit(req.query['limit']), parseExcludeIds(req.query['exclude']));
      return ApiResponseUtil.success(res, { cards });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load weekend plans');
    }
  }

  /** GET /api/social/weekend/feed/looking-for-plans */
  static async lookingForPlansFeed(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await resolveBuyerFromRequest(req);
      const cards = await WeekendService.getLookingForPlansCards(viewer, parseLimit(req.query['limit']), parseExcludeIds(req.query['exclude']));
      return ApiResponseUtil.success(res, { cards });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load "looking for plans"');
    }
  }

  /** POST /api/social/weekend/requests */
  static async createRequest(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const result = await WeekendService.createRequest(buyer, req.body || {});
      return ApiResponseUtil.success(res, result, 'Request sent');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to send request');
    }
  }

  /** GET /api/social/weekend/requests?status= */
  static async listRequests(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const status = req.query['status'] ? String(req.query['status']) : undefined;
      const requests = await WeekendService.listRequests(buyer, status);
      return ApiResponseUtil.success(res, { requests });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load requests');
    }
  }

  /** POST /api/social/weekend/requests/:id/accept */
  static async acceptRequest(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await WeekendService.respondToRequest(buyer, String(req.params['id'] || ''), true);
      return ApiResponseUtil.success(res, { status: 'accepted' }, 'Accepted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to accept request');
    }
  }

  /** POST /api/social/weekend/requests/:id/decline */
  static async declineRequest(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await WeekendService.respondToRequest(buyer, String(req.params['id'] || ''), false);
      return ApiResponseUtil.success(res, { status: 'declined' }, 'Declined');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to decline request');
    }
  }

  /** DELETE /api/social/weekend/requests/:id */
  static async cancelRequest(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await WeekendService.cancelRequest(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'Request cancelled');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to cancel request');
    }
  }
}
