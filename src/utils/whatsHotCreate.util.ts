import { WHATS_HOT_CATEGORIES, WhatsHotCategory } from '@/constants/whatsHotCategories';
import type { UpdateFeature } from '@interfaces/update.interface';

const VENUE_MAXLEN = 200;

export interface WhatsHotFields {
  feature?: UpdateFeature;
  hotCategory?: WhatsHotCategory;
  venue?: string;
  activityDate?: Date;
}

type Result = { ok: true; fields: WhatsHotFields } | { ok: false; message: string };

/**
 * Server-authoritative gate for the optional "What's Hot This Weekend"
 * fields on Update creation/edit (spec §2). All four are optional; when
 * `feature` isn't `'whats-hot'` the rest are ignored entirely (a plain post
 * never carries hotCategory/venue/activityDate) rather than silently
 * persisted as dead data.
 */
export function validateWhatsHotFields(body: any): Result {
  const feature = body?.feature;
  if (feature === undefined || feature === null) return { ok: true, fields: {} };
  if (feature !== 'whats-hot') return { ok: false, message: 'Invalid feature' };

  const fields: WhatsHotFields = { feature };

  if (body.hotCategory !== undefined && body.hotCategory !== null) {
    if (!WHATS_HOT_CATEGORIES.includes(body.hotCategory)) return { ok: false, message: 'Invalid hotCategory' };
    fields.hotCategory = body.hotCategory;
  }
  if (body.venue !== undefined && body.venue !== null) {
    if (typeof body.venue !== 'string' || body.venue.length > VENUE_MAXLEN) return { ok: false, message: 'Invalid venue' };
    if (body.venue.trim()) fields.venue = body.venue;
  }
  if (body.activityDate !== undefined && body.activityDate !== null) {
    const d = new Date(body.activityDate);
    if (Number.isNaN(d.getTime())) return { ok: false, message: 'Invalid activityDate' };
    fields.activityDate = d;
  }
  return { ok: true, fields };
}
