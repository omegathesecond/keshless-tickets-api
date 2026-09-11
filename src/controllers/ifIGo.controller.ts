import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import {
  createIfIGoStory,
  finalizeIfIGoStory,
  getIfIGoStory,
  respondToIfIGoStory,
  removeIfIGoResponse,
  toggleResponses,
  listRespondents,
  updateResponseStatus,
  confirmTicketPurchase,
  openConversationForOption,
  listOwnPlansForEvent,
} from '@services/ifIGo.service';
import type { IfIGoResponseStatus } from '@interfaces/ifIGo.interface';

const SETTABLE_STATUSES: IfIGoResponseStatus[] = ['accepted', 'declined', 'completed'];

/** "If I Go…" — a new interactive Story type (spec: If I Go…). Buyer-only
 *  throughout (see ifIGo.service's scope note) — unlike plain Story, there
 *  is no vendor/organizer twin of these routes. */
export class IfIGoController {
  static async create(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    try {
      assertNotSuspended(buyer);
      const body = req.body || {};
      if (!body.eventId || !HEX24.test(String(body.eventId))) return ApiResponseUtil.validationError(res, 'A valid eventId is required');
      if (!Array.isArray(body.options)) return ApiResponseUtil.validationError(res, 'options must be an array');
      const result = await createIfIGoStory(buyer, {
        eventId: String(body.eventId),
        options: body.options,
        allowMultiple: body.allowMultiple,
        audience: body.audience,
        caption: body.caption,
        background: body.background,
        media: body.media,
      });
      return ApiResponseUtil.created(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create If I Go… story');
    }
  }

  static async finalize(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const result = await finalizeIfIGoStory(id, buyer);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to finalize If I Go… story');
    }
  }

  /** GET — viewer may be anonymous (optionalTicketsAuth); public results are
   *  still gated inside the service by audience/blocked/expiry rules. */
  static async get(req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const buyer = await resolveBuyerFromRequest(req);
      const result = await getIfIGoStory(id, buyer);
      if (!result.available) {
        return ApiResponseUtil.success(res, result, result.reason === 'expired' ? 'This poll has ended and is no longer available' : 'Not available');
      }
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load If I Go… poll');
    }
  }

  static async respond(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      assertNotSuspended(buyer);
      const body = req.body || {};
      if (!Array.isArray(body.optionKeys) || body.optionKeys.length === 0) {
        return ApiResponseUtil.validationError(res, 'optionKeys must be a non-empty array');
      }
      const result = await respondToIfIGoStory(buyer, id, { optionKeys: body.optionKeys, privateMessage: body.privateMessage });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to respond');
    }
  }

  static async removeResponse(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      await removeIfIGoResponse(buyer, id);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove response');
    }
  }

  static async setResponsesEnabled(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    if (typeof req.body?.enabled !== 'boolean') return ApiResponseUtil.validationError(res, 'enabled must be a boolean');
    try {
      await toggleResponses(buyer, id, req.body.enabled);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update responses setting');
    }
  }

  static async respondents(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const respondents = await listRespondents(buyer, id);
      return ApiResponseUtil.success(res, { respondents });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load respondents');
    }
  }

  static async setResponseStatus(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    const respondentId = req.params['respondentId'] as string;
    if (!HEX24.test(id) || !HEX24.test(respondentId)) return ApiResponseUtil.validationError(res, 'Invalid id');
    const { optionKey, status } = req.body || {};
    if (!optionKey || !SETTABLE_STATUSES.includes(status)) {
      return ApiResponseUtil.validationError(res, `status must be one of ${SETTABLE_STATUSES.join(', ')}`);
    }
    try {
      await updateResponseStatus(buyer, id, respondentId, optionKey, status);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update response status');
    }
  }

  static async confirmTicket(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const result = await confirmTicketPurchase(buyer, id);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to confirm ticket purchase');
    }
  }

  static async openConversation(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    const optionKey = String(req.body?.optionKey || '');
    if (!optionKey) return ApiResponseUtil.validationError(res, 'optionKey is required');
    try {
      const result = await openConversationForOption(buyer, id, optionKey);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to open conversation');
    }
  }

  static async plans(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const plans = await listOwnPlansForEvent(buyer, id);
      return ApiResponseUtil.success(res, { plans });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load plans');
    }
  }
}
