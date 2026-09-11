import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { ShareEarnService } from '@services/shareEarn.service';

function vendorId(req: Request): string | null {
  return ((req as any).ticketsUser?.vendorId as string | undefined) ?? null;
}

/** Organizer dashboard Share&Earn surface — spec §1 and §10. */
export class ShareEarnOrganizerController {
  /** GET /api/tickets/events/:eventId/share-earn/campaign */
  static async getCampaign(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.getCampaign(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, { campaign: campaign ? ShareEarnService.toOrganizerCampaignView(campaign) : null });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Share&Earn campaign');
    }
  }

  /** PUT /api/tickets/events/:eventId/share-earn/campaign — create/update the DRAFT reward structure. */
  static async upsertCampaign(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.upsertCampaign(String(req.params['eventId']), { _id: new Types.ObjectId(vid) }, req.body || {});
      return ApiResponseUtil.success(res, { campaign: ShareEarnService.toOrganizerCampaignView(campaign) }, 'Share&Earn configuration saved');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to save Share&Earn configuration');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/campaign/activate — after the organizer previews + confirms (spec §1). */
  static async activate(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.activateCampaign(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, { campaign: ShareEarnService.toOrganizerCampaignView(campaign) }, 'Share&Earn is live');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to activate Share&Earn');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/campaign/pause */
  static async pause(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.pauseCampaign(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, { campaign: ShareEarnService.toOrganizerCampaignView(campaign) }, 'Share&Earn paused');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to pause Share&Earn');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/campaign/close */
  static async close(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.closeCampaign(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, { campaign: ShareEarnService.toOrganizerCampaignView(campaign) }, 'Share&Earn closed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to close Share&Earn');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/campaign/registrations { paused } */
  static async setRegistrationsPaused(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const campaign = await ShareEarnService.setRegistrationsPaused(String(req.params['eventId']), vid, !!req.body?.paused);
      return ApiResponseUtil.success(res, { campaign: ShareEarnService.toOrganizerCampaignView(campaign) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update promoter registrations');
    }
  }

  /** GET /api/tickets/events/:eventId/share-earn/dashboard — spec §10's full stat block. */
  static async dashboard(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const data = await ShareEarnService.getDashboard(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Share&Earn dashboard');
    }
  }

  /** GET /api/tickets/events/:eventId/share-earn/promoters?page=&limit= */
  static async promoters(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const page = Number(req.query['page']) || 1;
      const limit = Math.min(200, Number(req.query['limit']) || 50);
      const data = await ShareEarnService.listPromoters(String(req.params['eventId']), vid, page, limit);
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load promoters');
    }
  }

  /** GET /api/tickets/events/:eventId/share-earn/referrals/flagged */
  static async flaggedReferrals(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const referrals = await ShareEarnService.listFlaggedReferrals(String(req.params['eventId']), vid);
      return ApiResponseUtil.success(res, { referrals });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load flagged referrals');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/referrals/:referralId/review { action: 'approve'|'disqualify', reason? } */
  static async reviewReferral(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const action = req.body?.action === 'disqualify' ? 'disqualify' : 'approve';
      const referral = await ShareEarnService.reviewReferral(
        String(req.params['eventId']), vid, String(req.params['referralId']), action, req.body?.reason, new Types.ObjectId(vid)
      );
      return ApiResponseUtil.success(res, { referral }, action === 'approve' ? 'Referral approved' : 'Referral disqualified');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to review referral');
    }
  }

  /** POST /api/tickets/events/:eventId/share-earn/rewards/:rewardId/confirm — fulfilment approval (spec §10). */
  static async confirmReward(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const reward = await ShareEarnService.confirmRewardFulfilment(String(req.params['eventId']), vid, String(req.params['rewardId']));
      return ApiResponseUtil.success(res, { reward }, 'Reward confirmed — available for the promoter to redeem');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to confirm reward');
    }
  }

  /** GET /api/tickets/events/:eventId/share-earn/export.csv */
  static async exportCsv(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const csv = await ShareEarnService.exportCampaignCsv(String(req.params['eventId']), vid);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="share-earn-${req.params['eventId']}.csv"`);
      return res.status(200).send(csv);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to export Share&Earn report');
    }
  }
}
