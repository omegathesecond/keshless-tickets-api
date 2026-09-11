import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { EventPlanMessageService } from '@services/eventPlanMessage.service';

export class EventPlanMessageController {
  /** GET /api/social/plans/:id/messages?before=&limit= */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      const before = req.query['before'] ? String(req.query['before']) : undefined;
      const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      const messages = await EventPlanMessageService.list(
        String(req.params['id'] || ''),
        buyer ? String(buyer._id) : null,
        before,
        limit
      );
      return ApiResponseUtil.success(res, { messages });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load messages');
    }
  }

  /** POST /api/social/plans/:id/messages { body, replyTo? } */
  static async send(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const message = await EventPlanMessageService.send(
        buyer,
        String(req.params['id'] || ''),
        String(req.body?.body || ''),
        req.body?.replyTo ? String(req.body.replyTo) : undefined
      );
      return ApiResponseUtil.created(res, { message });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to send message');
    }
  }

  /** POST /api/social/plans/:id/messages/:messageId/react { emoji } */
  static async react(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.react(
        buyer,
        String(req.params['id'] || ''),
        String(req.params['messageId'] || ''),
        String(req.body?.emoji || '')
      );
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to react to message');
    }
  }

  /** DELETE /api/social/plans/:id/messages/:messageId/react */
  static async unreact(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.unreact(buyer, String(req.params['id'] || ''), String(req.params['messageId'] || ''));
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove reaction');
    }
  }
}
