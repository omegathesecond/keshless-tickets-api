import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getFeed, FeedSlide } from '@services/feed.service';
import { resolveActorFromRequest, isActorAuthorOf } from '@utils/socialActor.util';
import { getViewerReactions } from '@services/update.service';
import { getViewerEventReactions } from '@services/eventReaction.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const TABS = ['for-you', 'following', 'events'] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

export class FeedController {
  static async get(req: Request, res: Response): Promise<any> {
    const tab = String(req.query['tab'] || 'for-you');
    if (!isTab(tab)) return ApiResponseUtil.validationError(res, 'Invalid tab');
    const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
    const category = req.query['category'] ? String(req.query['category']) : undefined;
    // Client-computed "is it Thu/Fri/Sat in MY local timezone" (What's Hot
    // spec §1) — see FeedOpts.promoteHot's doc comment for why this can't be
    // derived server-side.
    const promoteHot = req.query['promoteHot'] === 'true';
    const actor = await resolveActorFromRequest(req).catch(() => null);
    try {
      const { items, nextCursor } = await getFeed({ tab, cursor, actor: actor ?? undefined, category, promoteHot });
      if (actor) {
        // Platform-staff moderator? Same rule as requireSuperAdminOrPermission
        // (MODERATE_SOCIAL) — computed once from the token, identical for every
        // slide, and surfaced so the client can offer the admin-only "Hide from
        // Discover" action. Same value across slides, but attached per-slide to
        // mirror viewerIsAuthor's shape.
        const staff = (req as any).ticketsUser;
        const canModerate =
          !!staff?.isSuperAdmin || (staff?.permissions || []).includes(TicketsPermission.MODERATE_SOCIAL);

        const updateIds = items.filter((i) => i.type === 'update').map((i) => i.id);
        if (updateIds.length) {
          const rx = await getViewerReactions(updateIds, actor);
          for (const i of items as FeedSlide[]) {
            if (i.type !== 'update') continue;
            i['viewerReactions'] = rx[i.id] ?? null;
            // The feed calls a vendor author 'organizer' (FeedAuthor.type) while
            // a SocialActor says 'vendor' — translate before comparing, or a
            // brand would never own its own post and the ⋯ delete would never
            // appear in the feed.
            const authorType = i.author.type === 'organizer' ? 'vendor' : 'buyer';
            i['viewerIsAuthor'] = isActorAuthorOf(authorType, i.author.id, actor);
            i['viewerCanModerate'] = canModerate;
          }
        }

        // Sibling of the block above, NOT nested inside it: a feed window can
        // contain event slides and no update slides (pattern: u u u e u u a e),
        // and nesting would drop event reactions in exactly that case.
        const eventIds = items.filter((i) => i.type === 'event').map((i) => i.id);
        if (eventIds.length) {
          const erx = await getViewerEventReactions(eventIds, actor);
          for (const i of items as FeedSlide[]) {
            if (i.type !== 'event') continue;
            i['viewerReactions'] = erx[i.id] ?? null;
          }
        }

        // A 'hot' slide's real posts are each item inside its `items` array,
        // not the slide itself (the slide's own `id` is a synthetic
        // `hot-<firstItemId>` key) — same viewerReactions treatment as the
        // 'update' block above, just addressed one level deeper.
        const hotItemIds = items.filter((i) => i.type === 'hot').flatMap((i: any) => (i.items as any[]).map((it) => it.id));
        if (hotItemIds.length) {
          const rx = await getViewerReactions(hotItemIds, actor);
          for (const i of items as FeedSlide[]) {
            if (i.type !== 'hot') continue;
            for (const it of (i as any).items) it.viewerReactions = rx[it.id] ?? null;
          }
        }
      }
      return ApiResponseUtil.success(res, { items, nextCursor });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to load feed', 500);
    }
  }
}
