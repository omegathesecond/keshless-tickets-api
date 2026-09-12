import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { getSeeAll, WhatsHotFilter, WhatsHotSort } from '@services/whatsHot.service';
import { WHATS_HOT_CATEGORIES } from '@/constants/whatsHotCategories';

const SORTS: WhatsHotSort[] = ['recommended', 'latest', 'most-viewed', 'most-liked'];
const FILTERS: WhatsHotFilter[] = ['All', 'Nearby', ...WHATS_HOT_CATEGORIES];

export class WhatsHotController {
  /** GET /api/public/whats-hot — the See All page (spec §7): category
   *  filter + sort, paginated. Public read, same as the rest of Discover. */
  static async seeAll(req: Request, res: Response): Promise<any> {
    try {
      const rawCategory = typeof req.query['category'] === 'string' ? req.query['category'] : 'All';
      if (!FILTERS.includes(rawCategory as WhatsHotFilter)) return ApiResponseUtil.validationError(res, 'Invalid category');
      const rawSort = typeof req.query['sort'] === 'string' ? req.query['sort'] : 'recommended';
      if (!SORTS.includes(rawSort as WhatsHotSort)) return ApiResponseUtil.validationError(res, 'Invalid sort');
      const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
      const rawLimit = req.query['limit'];
      const limit = rawLimit !== undefined ? Number(rawLimit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return ApiResponseUtil.validationError(res, 'Invalid limit');

      const result = await getSeeAll({ category: rawCategory as WhatsHotFilter, sort: rawSort as WhatsHotSort, cursor, limit });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load What\'s Hot');
    }
  }
}
