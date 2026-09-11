import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { IBuyer } from '@models/buyer.model';
import { ShareEarnService } from '@services/shareEarn.service';

/** The authenticated buyer, narrowed to the { _id } shape the service layer needs. */
function buyerRef(buyer: IBuyer): { _id: Types.ObjectId } {
  return { _id: buyer._id as Types.ObjectId };
}

/** Buyer + public Share&Earn surface — event page info/join, sharing/tracking, My Share&Earn. */
export class ShareEarnController {
  /** GET /api/public/events/:eventId/share-earn — visible logged out (spec §2). */
  static async getEventCampaign(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      const result = await ShareEarnService.getPublicCampaign(String(req.params['eventId']), buyer ? String(buyer._id) : undefined);
      return ApiResponseUtil.success(res, result ?? { campaign: null, joined: null });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Share&Earn');
    }
  }

  /** POST /api/public/events/:eventId/share-earn/join — auth required (spec §3). */
  static async join(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to join Share&Earn');
      const { promoter, campaign } = await ShareEarnService.joinCampaign(String(req.params['eventId']), buyerRef(buyer));
      return ApiResponseUtil.created(res, ShareEarnService.toPromoterBuyerView(promoter, campaign), 'You joined Share&Earn');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to join Share&Earn');
    }
  }

  /** PATCH /api/public/share-earn/promoters/:promoterId/leaderboard-opt-out { optOut } */
  static async setLeaderboardOptOut(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const promoter = await ShareEarnService.setLeaderboardOptOut(buyerRef(buyer), String(req.params['promoterId']), !!req.body?.optOut);
      return ApiResponseUtil.success(res, { optOutLeaderboard: promoter.optOutLeaderboard });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update leaderboard preference');
    }
  }

  /**
   * POST /api/public/share-earn/track-click { referralCode, visitorKey } — public,
   * no auth: a visitor may browse the event before signing in (spec §4).
   */
  static async trackClick(req: Request, res: Response): Promise<any> {
    try {
      const referralCode = String(req.body?.referralCode || '');
      if (!referralCode) return ApiResponseUtil.badRequest(res, 'referralCode is required');
      const visitorKey = String(req.body?.visitorKey || '');
      const result = await ShareEarnService.trackClick(referralCode, visitorKey, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] as string | undefined,
      });
      return ApiResponseUtil.success(res, result ?? { eventId: null });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to record click');
    }
  }

  /** GET /api/public/share-earn/resolve/:referralCode — public, so a shared link opens the right event even logged out. */
  static async resolveCode(req: Request, res: Response): Promise<any> {
    try {
      const result = await ShareEarnService.resolveReferralCode(String(req.params['referralCode']));
      if (!result) return ApiResponseUtil.notFound(res, 'Referral link not found');
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to resolve referral link');
    }
  }

  /** GET /api/public/my-share-earn — Active / Completed / Rewards (spec §9). */
  static async mine(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const result = await ShareEarnService.getMyShareEarn(buyerRef(buyer));
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load My Share&Earn');
    }
  }

  /** POST /api/public/share-earn/rewards/:rewardId/redeem — non-points rewards only. */
  static async redeemReward(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const reward = await ShareEarnService.redeemReward(buyerRef(buyer), String(req.params['rewardId']));
      return ApiResponseUtil.success(res, ShareEarnService.toRewardBuyerView(reward), 'Reward redeemed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to redeem reward');
    }
  }

  /** GET /api/public/events/:eventId/share-earn/leaderboard */
  static async leaderboard(req: Request, res: Response): Promise<any> {
    try {
      const rows = await ShareEarnService.getLeaderboard(String(req.params['eventId']));
      return ApiResponseUtil.success(res, { leaderboard: rows ?? [] });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load leaderboard');
    }
  }
}
