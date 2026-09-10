import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { EventPlanService } from '@services/eventPlan.service';

async function viewerId(req: Request): Promise<string | null> {
  const buyer = await resolveBuyerFromRequest(req);
  return buyer ? String(buyer._id) : null;
}

export class EventPlanController {
  /** GET /api/social/plans/event/:eventId */
  static async listForEvent(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await viewerId(req);
      const plans = await EventPlanService.listForEvent(String(req.params['eventId'] || ''), viewer);
      return ApiResponseUtil.success(res, { plans });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load plans');
    }
  }

  /** POST /api/social/plans */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const plan = await EventPlanService.create(buyer, req.body || {});
      const detail = await EventPlanService.getDetail(String(plan._id), String(buyer._id));
      return ApiResponseUtil.created(res, detail, 'Plan created');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create plan');
    }
  }

  /** GET /api/social/plans/mine?section=upcoming|invitations|past */
  static async mine(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const section = String(req.query['section'] || 'upcoming') as 'upcoming' | 'invitations' | 'past';
      if (!['upcoming', 'invitations', 'past'].includes(section)) return ApiResponseUtil.error(res, 'Invalid section', 400);
      const plans = await EventPlanService.getMine(buyer, section);
      return ApiResponseUtil.success(res, { plans });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load your plans');
    }
  }

  /** GET /api/social/plans/:id */
  static async detail(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await viewerId(req);
      const plan = await EventPlanService.getDetail(String(req.params['id'] || ''), viewer);
      return ApiResponseUtil.success(res, { plan });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load plan');
    }
  }

  /** GET /api/social/plans/:id/pending — admin-only invited+requested rows. */
  static async pending(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const pending = await EventPlanService.getPending(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, pending);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load pending members');
    }
  }

  /** PATCH /api/social/plans/:id */
  static async update(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.update(buyer, String(req.params['id'] || ''), req.body || {});
      const detail = await EventPlanService.getDetail(String(req.params['id'] || ''), String(buyer._id));
      return ApiResponseUtil.success(res, { plan: detail }, 'Plan updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update plan');
    }
  }

  /** PATCH /api/social/plans/:id/visibility { visibility, confirmed } */
  static async changeVisibility(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.changeVisibility(
        buyer,
        String(req.params['id'] || ''),
        req.body?.visibility,
        Boolean(req.body?.confirmed)
      );
      const detail = await EventPlanService.getDetail(String(req.params['id'] || ''), String(buyer._id));
      return ApiResponseUtil.success(res, { plan: detail }, 'Visibility updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update visibility');
    }
  }

  /** POST /api/social/plans/:id/cancel */
  static async cancel(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.cancel(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'Plan cancelled');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to cancel plan');
    }
  }

  /** POST /api/social/plans/:id/join */
  static async join(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.requestToJoin(buyer, String(req.params['id'] || ''));
      const detail = await EventPlanService.getDetail(String(req.params['id'] || ''), String(buyer._id));
      return ApiResponseUtil.success(res, { plan: detail });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to join plan');
    }
  }

  /** POST /api/social/plans/:id/leave */
  static async leave(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.leave(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'You left the plan');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to leave plan');
    }
  }

  /** POST /api/social/plans/:id/invite { buyerIds: string[] } */
  static async invite(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const buyerIds = Array.isArray(req.body?.buyerIds) ? req.body.buyerIds.map(String) : [];
      const result = await EventPlanService.inviteMembers(buyer, String(req.params['id'] || ''), buyerIds);
      return ApiResponseUtil.success(res, result, 'Invitations sent');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to send invitations');
    }
  }

  /** POST /api/social/plans/:id/invite/:memberId/cancel */
  static async cancelInvite(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.cancelInvite(buyer, String(req.params['id'] || ''), String(req.params['memberId'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'Invitation cancelled');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to cancel invitation');
    }
  }

  /** POST /api/social/plans/:id/members/:memberId/remove */
  static async removeMember(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.removeMember(buyer, String(req.params['id'] || ''), String(req.params['memberId'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'Member removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove member');
    }
  }

  /** POST /api/social/plans/invites/:memberId/accept | decline */
  static async respondToInvite(req: Request, res: Response, accept: boolean): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.respondToInvite(buyer, String(req.params['memberId'] || ''), accept);
      return ApiResponseUtil.success(res, { status: accept ? 'accepted' : 'declined' });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to respond to invitation');
    }
  }

  static acceptInvite(req: Request, res: Response) {
    return EventPlanController.respondToInvite(req, res, true);
  }

  static declineInvite(req: Request, res: Response) {
    return EventPlanController.respondToInvite(req, res, false);
  }

  /** POST /api/social/plans/requests/:memberId/approve | decline */
  static async respondToRequest(req: Request, res: Response, approve: boolean): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.respondToRequest(buyer, String(req.params['memberId'] || ''), approve);
      return ApiResponseUtil.success(res, { status: approve ? 'accepted' : 'declined' });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to respond to request');
    }
  }

  static approveRequest(req: Request, res: Response) {
    return EventPlanController.respondToRequest(req, res, true);
  }

  static declineRequest(req: Request, res: Response) {
    return EventPlanController.respondToRequest(req, res, false);
  }

  /** POST /api/social/plans/:id/attendance { status } */
  static async vote(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanService.vote(buyer, String(req.params['id'] || ''), req.body?.status);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to record your response');
    }
  }
}
