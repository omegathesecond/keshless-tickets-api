import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { createStory, deleteStory, finalizeStory, listForViewer, listLikers, listViewers, markSeen, toggleLike } from '@services/story.service';
import { deleteIfIGoStory } from '@services/ifIGo.service';
import { Buyer } from '@models/buyer.model';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import { isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';
import { Story } from '@models/story.model';
import type { StoryKind } from '@interfaces/story.interface';

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Ephemeral (24h) media posts, for BOTH actors: a buyer (behind
 * authenticateBuyer at /api/social/stories) and an organizer brand (behind
 * authenticateTickets at /api/tickets/social/stories) — see
 * @routes/social.route and @routes/vendorSocial.route. The split lives only at
 * the entry point, because the two mounts use different auth middleware; every
 * body below is shared and takes a SocialActor, exactly like
 * @controllers/update.controller's create/createAsVendor pair.
 *
 * story.service was actor-shaped from the start (Story.authorType enums
 * 'buyer' | 'vendor'), so brand stories needed no service or model change —
 * only these vendor entry points.
 */
export class StoryController {
  /** The vendor actor for a tickets session, or null for anything else.
   *  authenticateTickets does NOT reject buyer tokens (only authenticateBuyer
   *  checks userType) — a buyer token simply carries no vendorId, so it lands
   *  here as null and 401s. Mirrors UpdateController.createAsVendor. */
  private static vendorActor(req: Request): SocialActor | null {
    const vendorId = (req as any).ticketsUser?.vendorId;
    return vendorId ? { type: 'vendor', id: String(vendorId) } : null;
  }

  static async create(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    try {
      // A suspended buyer's community access is revoked platform-wide — a
      // Story is world-readable content, so it's gated the same as
      // follow/review/message (see @utils/socialSuspension.util). There is no
      // vendor twin of this check because suspension is a buyer-only concept
      // (same as vendor Updates, which carry no suspension gate either).
      assertNotSuspended(buyer);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create story');
    }
    return StoryController.createFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** POST /api/tickets/social/stories — a brand posts a status. */
  static async createAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.createFor(actor, req, res);
  }

  private static async createFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    try {
      const { kind, ext, contentType } = req.body || {};
      if (kind !== 'video' && kind !== 'image') return ApiResponseUtil.validationError(res, 'kind must be video or image');
      const allow = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
      if (!allow.includes(contentType)) return ApiResponseUtil.validationError(res, `Invalid contentType for ${kind}`);
      const { story, uploadUrl } = await createStory({
        actor,
        kind: kind as StoryKind,
        ext: String(ext || 'bin'),
        contentType,
      });
      return ApiResponseUtil.created(res, { storyId: story.id, uploadUrl });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create story');
    }
  }

  static async finalize(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.finalizeFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** POST /api/tickets/social/stories/:id/finalize */
  static async finalizeAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.finalizeFor(actor, req, res);
  }

  private static async finalizeFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    const existing = await Story.findById(id).select('authorType authorId');
    if (!existing) return ApiResponseUtil.notFound(res, 'Story not found');
    // authorType is load-bearing, not cosmetic: an id-only comparison would let
    // a buyer whose _id collided with a vendor's finalize that brand's story.
    if (!isActorAuthorOf(existing.authorType, existing.authorId, actor)) {
      return ApiResponseUtil.forbidden(res, 'Not your story');
    }
    try {
      const story = await finalizeStory(id);
      return ApiResponseUtil.success(res, { id: story.id, kind: story.kind, media: story.media });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to finalize story');
    }
  }

  static async list(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.listFor({ type: 'buyer', id: String(buyer._id) }, res);
  }

  /** GET /api/tickets/social/stories — the brand's own status plus those of
   *  the accounts it follows (the organizer Home rail). */
  static async listAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.listFor(actor, res);
  }

  private static async listFor(actor: SocialActor, res: Response): Promise<any> {
    try {
      const stories = await listForViewer(actor);
      return ApiResponseUtil.success(res, { stories });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load stories');
    }
  }

  /** DELETE /api/social/stories/:id — author deletes their own story. */
  static async remove(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.removeFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** DELETE /api/tickets/social/stories/:id */
  static async removeAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.removeFor(actor, req, res);
  }

  private static async removeFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const existing = await Story.findById(id).select('kind');
      if (existing?.kind === 'if_i_go') {
        // 'if_i_go' carries its own sibling rows (IfIGoStory/IfIGoResponse —
        // see @models/ifIGoStory.model) that the generic deleteStory below
        // has no idea exist, so it's routed to ifIGo.service instead. Always
        // buyer-only for this kind (see ifIGo.service's scope note).
        if (actor.type !== 'buyer') return ApiResponseUtil.forbidden(res, 'Not your story');
        const buyer = await Buyer.findById(actor.id);
        if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
        await deleteIfIGoStory(buyer, id);
        return ApiResponseUtil.success(res, { ok: true });
      }
      await deleteStory(id, actor);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete story');
    }
  }

  static async seen(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.seenFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** POST /api/tickets/social/stories/:id/seen */
  static async seenAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.seenFor(actor, req, res);
  }

  private static async seenFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      await markSeen(id, actor);
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark story seen');
    }
  }

  static async like(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.likeFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** POST /api/tickets/social/stories/:id/like */
  static async likeAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.likeFor(actor, req, res);
  }

  /** Toggles the caller's like on one story item — liked -> unliked and back. */
  private static async likeFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const result = await toggleLike(id, actor);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to like story');
    }
  }

  /**
   * WhatsApp-style "viewed by" list for one story. Author-only — the service
   * throws 403 for anyone else, so a nosy viewer gets a refusal rather than
   * an empty list that would read as "nobody has seen this".
   */
  static async viewers(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.viewersFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** GET /api/tickets/social/stories/:id/viewers */
  static async viewersAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.viewersFor(actor, req, res);
  }

  private static async viewersFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const viewers = await listViewers(id, actor);
      return ApiResponseUtil.success(res, { viewers, count: viewers.length });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load story viewers');
    }
  }

  /**
   * Who has liked one story, newest first. Author-only — the service throws
   * 403 for anyone else, same privacy rule as `viewers` above.
   */
  static async likers(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    return StoryController.likersFor({ type: 'buyer', id: String(buyer._id) }, req, res);
  }

  /** GET /api/tickets/social/stories/:id/likers */
  static async likersAsVendor(req: Request, res: Response): Promise<any> {
    const actor = StoryController.vendorActor(req);
    if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    return StoryController.likersFor(actor, req, res);
  }

  private static async likersFor(actor: SocialActor, req: Request, res: Response): Promise<any> {
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      const likers = await listLikers(id, actor);
      return ApiResponseUtil.success(res, { likers, count: likers.length });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load story likers');
    }
  }
}
