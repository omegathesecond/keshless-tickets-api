import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { resolveActorFromRequest, isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { createUpdate, finalizeUpdate, getUpdate, editUpdateCaption, toggleReaction, recordShare, recordView, getViewerReactions } from '@services/update.service';
import { resolveUpdateAuthor } from '@services/updateAuthor';
import { validateCreateItems } from '@utils/updateCreate.util';
import { Update } from '@models/update.model';
import type { UpdateAuthorType, UpdateCategory } from '@interfaces/update.interface';
import { UPDATE_CATEGORIES } from '@interfaces/update.interface';

const AUTHOR_TYPES: UpdateAuthorType[] = ['buyer', 'vendor'];
const PAGE_SIZE = 24;
/** Shared by create, createAsVendor and editCaption — one caption-length rule
 *  everywhere it's enforced, per the "same limits used when creating a post"
 *  requirement on edits. */
const MAX_CAPTION_LENGTH = 500;
const MAX_LOCATION_LENGTH = 120;

/** Validates the optional `category`/`location` body fields shared by create
 *  and createAsVendor — kept in one place so the two entry points can't
 *  drift, same reasoning as MAX_CAPTION_LENGTH above. */
function validatePostMeta(body: any): { ok: true; category: UpdateCategory; location?: string } | { ok: false; message: string } {
  const category = body?.category ?? 'general';
  if (!UPDATE_CATEGORIES.includes(category)) return { ok: false, message: `category must be one of ${UPDATE_CATEGORIES.join(', ')}` };
  const location = body?.location;
  if (location !== undefined && location !== null && typeof location !== 'string') {
    return { ok: false, message: 'location must be a string' };
  }
  if (typeof location === 'string' && location.length > MAX_LOCATION_LENGTH) {
    return { ok: false, message: `location must be ${MAX_LOCATION_LENGTH} characters or fewer` };
  }
  return { ok: true, category, location: location || undefined };
}

export class UpdateController {
  static async create(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const { caption = '', eventId, items } = req.body || {};
    if (typeof caption === 'string' && caption.length > MAX_CAPTION_LENGTH) return ApiResponseUtil.validationError(res, 'caption too long');
    const v = validateCreateItems(req.body?.kind, items);
    if (!v.ok) return ApiResponseUtil.validationError(res, v.message);
    const meta = validatePostMeta(req.body);
    if (!meta.ok) return ApiResponseUtil.validationError(res, meta.message);
    try {
      const { update, uploads } = await createUpdate({
        authorType: 'buyer', authorId: String(buyer._id), kind: v.kind, category: meta.category, caption, location: meta.location, eventId, items: v.items,
      });
      return ApiResponseUtil.created(res, { updateId: update.id, uploads });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to create update', 500);
    }
  }

  static async finalize(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const update = await Update.findById(req.params['id'] as string);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    if (String(update.authorId) !== String(buyer._id)) return ApiResponseUtil.forbidden(res, 'Not your update');
    try {
      const out = await finalizeUpdate(update.id);
      return ApiResponseUtil.success(res, UpdateController.dto(out));
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to finalize', 500);
    }
  }

  /**
   * Vendor (organizer dashboard) equivalent of create(). Vendor tokens carry
   * `vendorId` on req.ticketsUser (not `userPhone` like buyer tokens) — see
   * authenticateTickets in @middleware/ticketsAuth.middleware. Note that
   * authenticateTickets does NOT itself reject buyer tokens (only
   * authenticateBuyer checks userType); a buyer token still 401s here
   * because it carries no vendorId.
   */
  static async createAsVendor(req: Request, res: Response): Promise<any> {
    const vendorId = (req as any).ticketsUser?.vendorId;
    if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    const { caption = '', eventId, items } = req.body || {};
    if (typeof caption === 'string' && caption.length > MAX_CAPTION_LENGTH) return ApiResponseUtil.validationError(res, 'caption too long');
    const v = validateCreateItems(req.body?.kind, items);
    if (!v.ok) return ApiResponseUtil.validationError(res, v.message);
    const meta = validatePostMeta(req.body);
    if (!meta.ok) return ApiResponseUtil.validationError(res, meta.message);
    try {
      const { update, uploads } = await createUpdate({
        authorType: 'vendor', authorId: String(vendorId), kind: v.kind, category: meta.category, caption, location: meta.location, eventId, items: v.items,
      });
      return ApiResponseUtil.created(res, { updateId: update.id, uploads });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to create update', 500);
    }
  }

  /**
   * Vendor equivalent of finalize(): only the authoring vendor may finalize
   * their own update.
   */
  static async finalizeAsVendor(req: Request, res: Response): Promise<any> {
    const vendorId = (req as any).ticketsUser?.vendorId;
    if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
    const update = await Update.findById(req.params['id'] as string);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    if (String(update.authorId) !== String(vendorId)) return ApiResponseUtil.forbidden(res, 'Not your update');
    try {
      const out = await finalizeUpdate(update.id);
      return ApiResponseUtil.success(res, UpdateController.dto(out));
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to finalize', 500);
    }
  }

  /**
   * PATCH /api/public/updates/:id — edit a published post's caption in
   * place. ONE path for both buyer- and vendor-authored posts (mounted with
   * optionalTicketsAuth, actor resolved here), same reasoning as remove():
   * updateBase() would send a vendor to /api/tickets/updates, which has no
   * PATCH.
   *
   * Ownership is enforced HERE, server-side — never trust the client's menu
   * gating alone. A platform superadmin may also edit (same moderator
   * carve-out as remove()'s isSuperAdmin bypass).
   */
  static async editCaption(req: Request, res: Response): Promise<any> {
    const { caption } = req.body || {};
    if (typeof caption !== 'string') return ApiResponseUtil.validationError(res, 'caption is required');
    if (caption.length > MAX_CAPTION_LENGTH) return ApiResponseUtil.validationError(res, 'caption too long');

    const actor = await resolveActorFromRequest(req).catch(() => null);
    const isSuperAdmin = (req as any).ticketsUser?.isSuperAdmin === true;
    const update = await Update.findById(req.params['id'] as string);
    if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
    if (!UpdateController.isActorAuthor(update, actor) && !isSuperAdmin) return ApiResponseUtil.forbidden(res, 'Not your post');

    try {
      const updated = await editUpdateCaption(update.id, caption);
      return ApiResponseUtil.success(res, UpdateController.dto(updated, undefined, UpdateController.isActorAuthor(updated, actor)));
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to save caption', 500);
    }
  }

  static async getOne(req: Request, res: Response): Promise<any> {
    const update = await getUpdate(req.params['id'] as string);
    if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
    let reactions: { liked: boolean; saved: boolean } | undefined;
    const actor = await resolveActorFromRequest(req).catch(() => null);
    if (actor) reactions = (await getViewerReactions([update.id], actor))[update.id];
    // Hydrated author (unlike the by-author/for-event/feed list mappings below,
    // which intentionally omit it — grids need no author header): a cold/shared
    // /post/:id link has no other way to render who posted it, since buyers
    // have no public get-by-id endpoint.
    const author = await resolveUpdateAuthor(update.authorType, String(update.authorId));
    return ApiResponseUtil.success(res, UpdateController.dto(update, reactions, UpdateController.isActorAuthor(update, actor), author));
  }

  /**
   * GET /api/public/updates/by/:authorType/:authorId — an author's own
   * ready posts, newest first (profile grid: organizer "Posts" tab, buyer
   * posts). Public read; if a tickets token resolves to a social actor,
   * viewerReactions is populated on each item like getOne()/getFeed() do.
   *
   * "Ready" = the model's real fields: top-level status:'active' (not
   * 'removed') AND media.status:'ready' (transcode/finalize complete) —
   * there is no single status:'ready' field on Update.
   */
  static async listByAuthor(req: Request, res: Response): Promise<any> {
    try {
      const authorType = String(req.params['authorType'] || '');
      const authorId = String(req.params['authorId'] || '');
      if (!AUTHOR_TYPES.includes(authorType as UpdateAuthorType) || !HEX24.test(authorId)) {
        return ApiResponseUtil.validationError(res, 'Invalid author');
      }
      const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
      const filter: any = { authorType, authorId, status: 'active', 'media.status': 'ready' };
      if (cursor) {
        const d = new Date(cursor);
        if (Number.isNaN(d.getTime())) return ApiResponseUtil.error(res, 'Invalid cursor', 400);
        filter.createdAt = { $lt: d };
      }

      const docs = await Update.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1);
      const page = docs.slice(0, PAGE_SIZE);
      const nextCursor = docs.length > PAGE_SIZE ? new Date(page[page.length - 1]!.createdAt).toISOString() : null;

      const actor = await resolveActorFromRequest(req).catch(() => null);
      const reactions = actor && page.length ? await getViewerReactions(page.map((d) => d.id), actor) : undefined;
      const items = page.map((d) => UpdateController.dto(d, reactions?.[d.id], UpdateController.isActorAuthor(d, actor)));

      return ApiResponseUtil.success(res, { items, nextCursor });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load posts');
    }
  }

  /**
   * GET /api/public/updates/for-event/:eventId — posts tagged to one event,
   * newest first. Powers the Media tab on the event quick-view, where
   * attendees share photos/videos from that specific show.
   *
   * Deliberately the same visibility filter as listByAuthor (active + media
   * ready): a post still transcoding has no playable URL, and a removed one
   * must not resurface here just because it carries an eventId.
   */
  static async listByEvent(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId'] || '');
      if (!HEX24.test(eventId)) return ApiResponseUtil.validationError(res, 'Invalid event');

      const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
      const filter: any = { eventId, status: 'active', 'media.status': 'ready' };
      if (cursor) {
        const d = new Date(cursor);
        if (Number.isNaN(d.getTime())) return ApiResponseUtil.error(res, 'Invalid cursor', 400);
        filter.createdAt = { $lt: d };
      }

      const docs = await Update.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1);
      const page = docs.slice(0, PAGE_SIZE);
      const nextCursor = docs.length > PAGE_SIZE ? new Date(page[page.length - 1]!.createdAt).toISOString() : null;

      const actor = await resolveActorFromRequest(req).catch(() => null);
      const reactions = actor && page.length ? await getViewerReactions(page.map((d) => d.id), actor) : undefined;
      const items = page.map((d) => UpdateController.dto(d, reactions?.[d.id], UpdateController.isActorAuthor(d, actor)));

      return ApiResponseUtil.success(res, { items, nextCursor });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load event media');
    }
  }

  static react(type: 'like' | 'save') {
    return async (req: Request, res: Response): Promise<any> => {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const update = await Update.findById(req.params['id'] as string).select('_id status');
      if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
      const r = await toggleReaction(req.params['id'] as string, { type: 'buyer', id: String(buyer._id) }, type);
      return ApiResponseUtil.success(res, r);
    };
  }

  /** Vendor (organizer) reaction — the brand likes/saves a post. */
  static reactAsVendor(type: 'like' | 'save') {
    return async (req: Request, res: Response): Promise<any> => {
      const vendorId = (req as any).ticketsUser?.vendorId;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const update = await Update.findById(req.params['id'] as string).select('_id status');
      if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
      const r = await toggleReaction(req.params['id'] as string, { type: 'vendor', id: String(vendorId) }, type);
      return ApiResponseUtil.success(res, r);
    };
  }

  static async share(req: Request, res: Response): Promise<any> {
    const r = await recordShare(req.params['id'] as string);
    return ApiResponseUtil.success(res, r);
  }

  static async recordView(req: Request, res: Response): Promise<any> {
    const actor = await resolveActorFromRequest(req).catch(() => null);
    const r = await recordView(req.params['id'] as string, actor);
    return ApiResponseUtil.success(res, r);
  }

  /**
   * DELETE /api/public/updates/:id — soft-delete (status:'removed'), author or
   * superadmin only. Mounted with optionalTicketsAuth: the route accepts any
   * tickets token (buyer OR vendor) and authorization happens HERE.
   *
   * Resolves a SocialActor, not a buyer: a brand post has authorType:'vendor'
   * and resolveBuyerFromRequest returns null for a vendor token, which used to
   * 403 organizers on their own posts.
   */
  static async remove(req: Request, res: Response): Promise<any> {
    const actor = await resolveActorFromRequest(req).catch(() => null);
    const isSuperAdmin = (req as any).ticketsUser?.isSuperAdmin === true;
    const update = await Update.findById(req.params['id'] as string);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    const isAuthor = UpdateController.isActorAuthor(update, actor);
    if (!isAuthor && !isSuperAdmin) return ApiResponseUtil.forbidden(res, 'Not allowed');
    update.status = 'removed';
    await update.save();
    return ApiResponseUtil.success(res, { ok: true });
  }

  /**
   * POST /api/tickets/updates/:id/hide-from-discover — platform staff withhold
   * a post from the public Discover ('for-you') feed. The route already gates
   * on requireSuperAdminOrPermission(MODERATE_SOCIAL), so no auth check here.
   *
   * Discover-ONLY: unlike remove() (status:'removed', gone everywhere), this
   * only sets a moderation stamp the feed service filters on for 'for-you' —
   * the post stays live on the author's profile and in followers' feeds.
   * Idempotent: re-hiding keeps the original stamp.
   */
  static async hideFromDiscover(req: Request, res: Response): Promise<any> {
    const id = String(req.params['id'] || '');
    if (!HEX24.test(id)) return ApiResponseUtil.error(res, 'Invalid update id', 400);
    const update = await Update.findById(id);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    if (!update.hiddenFromDiscoverAt) {
      const staff = (req as any).ticketsUser;
      update.hiddenFromDiscoverAt = new Date();
      update.hiddenFromDiscoverBy = String(staff?.userId || staff?.vendorId || '');
      await update.save();
    }
    return ApiResponseUtil.success(res, { ok: true, hidden: true });
  }

  /** DELETE /api/tickets/updates/:id/hide-from-discover — un-hide, restoring
   *  the post to Discover. Idempotent. Same MODERATE_SOCIAL gate. */
  static async unhideFromDiscover(req: Request, res: Response): Promise<any> {
    const id = String(req.params['id'] || '');
    if (!HEX24.test(id)) return ApiResponseUtil.error(res, 'Invalid update id', 400);
    const update = await Update.findById(id);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    if (update.hiddenFromDiscoverAt) {
      update.hiddenFromDiscoverAt = null;
      update.hiddenFromDiscoverBy = null;
      await update.save();
    }
    return ApiResponseUtil.success(res, { ok: true, hidden: false });
  }

  /** Ownership for an Update document. The rule itself lives in
   *  socialActor.util — the feed shares it through a different vocabulary. */
  static isActorAuthor(update: any, actor: SocialActor | null): boolean {
    return isActorAuthorOf(update.authorType, update.authorId, actor);
  }

  /**
   * `viewerIsAuthor` defaults false so call sites with no resolved actor
   * (create/finalize) stay truthful rather than claiming ownership.
   */
  static dto(update: any, reactions?: { liked: boolean; saved: boolean }, viewerIsAuthor = false, author?: unknown) {
    return {
      id: update.id,
      authorType: update.authorType,
      authorId: String(update.authorId),
      kind: update.kind,
      category: update.category ?? 'general',
      caption: update.caption,
      location: update.location ?? null,
      editedAt: update.editedAt ? update.editedAt.toISOString() : null,
      eventId: update.eventId ? String(update.eventId) : null,
      media: update.media,
      likeCount: update.likeCount,
      saveCount: update.saveCount,
      shareCount: update.shareCount,
      viewCount: update.viewCount ?? 0,
      commentCount: update.commentCount ?? 0,
      createdAt: update.createdAt,
      viewerReactions: reactions ?? null,
      viewerIsAuthor,
      ...(author ? { author } : {}),
    };
  }
}
