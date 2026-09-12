import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { UpdateService } from '@services/update.service';
import { listWeekendRecaps, pickWeekendRecapLabel } from '@services/weekendRecap.service';

// See-All page: page-based pagination (not the cursor convention used by
// updates/by and updates/for-event), same shape as topicPostsQuerySchema.
export const weekendRecapsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  sort: Joi.string().valid('recommended', 'latest', 'most_viewed', 'most_liked').default('recommended'),
  filter: Joi.string().valid('events', 'vacations', 'nightlife', 'music', 'food', 'travel', 'nearby').optional(),
});

export class WeekendRecapController {
  /**
   * GET /api/public/weekend-recaps — the Weekend Recap "See All" page.
   * Unlike listByAuthor/listByEvent (grids that intentionally omit author —
   * every tile already shares one), this page renders full post cards
   * spanning MANY different authors, so it reuses
   * UpdateService.buildUpdateSlides — the same author+reaction-hydrated
   * feed-slide shape Home/Discover/profile already render — rather than
   * UpdateController.dto (which has no per-post author).
   */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = weekendRecapsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const { page, limit, sort, filter } = value;

      const { docs, hasMore } = await listWeekendRecaps({ page, limit, sort, filter });

      const actor = await resolveActorFromRequest(req).catch(() => null);
      const slides = await UpdateService.buildUpdateSlides(docs, actor);
      const posts = slides.map((s) => ({ ...s, label: pickWeekendRecapLabel(s.id) }));

      return ApiResponseUtil.success(res, { posts, page, hasMore });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Weekend Recap posts');
    }
  }
}
