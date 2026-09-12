import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { UpdateController } from '@controllers/update.controller';
import { getViewerReactions } from '@services/update.service';
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
   * Same visibility filter and per-post DTO as every other Update listing
   * (getTopicPosts/listByAuthor/listByEvent); older recap posts stay
   * reachable here even once they age out of the Home-feed slot.
   */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = weekendRecapsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const { page, limit, sort, filter } = value;

      const { docs, hasMore } = await listWeekendRecaps({ page, limit, sort, filter });

      const actor = await resolveActorFromRequest(req).catch(() => null);
      const reactions = actor && docs.length ? await getViewerReactions(docs.map((d) => d.id), actor) : undefined;
      const posts = docs.map((d) => ({
        ...UpdateController.dto(d, reactions?.[d.id], UpdateController.isActorAuthor(d, actor)),
        label: pickWeekendRecapLabel(d.id),
      }));

      return ApiResponseUtil.success(res, { posts, page, hasMore });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load Weekend Recap posts');
    }
  }
}
