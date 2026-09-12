import mongoose, { Schema, Document, Types } from 'mongoose';
import type { UpdateAuthorType, UpdateFeature, UpdateKind, UpdateMedia } from '@interfaces/update.interface';
import { WHATS_HOT_CATEGORIES, WhatsHotCategory } from '@/constants/whatsHotCategories';
import { mediaSchema } from '@models/shared/media.schema';

export interface IUpdate extends Document {
  authorType: UpdateAuthorType;
  authorId: Types.ObjectId;
  kind: UpdateKind;
  caption: string;
  hashtags: string[];
  eventId?: Types.ObjectId;
  media: UpdateMedia[];
  likeCount: number;
  saveCount: number;
  shareCount: number;
  viewCount: number;
  /** Maintained by updateComment.service ($inc on create, clamped $subtract on
   *  soft-delete) — never recomputed from a count() on read. */
  commentCount: number;
  status: 'active' | 'removed';
  /** Platform-staff moderation: when set, this post is withheld from the
   *  public Discover ('for-you') feed only — it stays live on the author's
   *  profile and in followers' feeds. Cleared to un-hide. Distinct from
   *  `status: 'removed'`, which takes the post down everywhere. */
  hiddenFromDiscoverAt?: Date | null;
  /** The moderator (vendor/sub-user id) who hid it — audit trail for the above. */
  hiddenFromDiscoverBy?: string | null;
  /** "What's Hot This Weekend" section membership — see UpdateFeature's doc
   *  comment. `null`/absent for every ordinary post. */
  feature?: UpdateFeature | null;
  /** Only meaningful when `feature: 'whats-hot'` — the See All page's
   *  category filter. */
  hotCategory?: WhatsHotCategory | null;
  /** Venue or destination text (spec §2/§4) — free text, not a linked Event;
   *  a post can also carry a real `eventId` alongside this. */
  venue?: string | null;
  /** When the promoted activity/event happens — drives the This
   *  Weekend/Starts Tomorrow/Weekend Loading label and expiry (see
   *  @services/whatsHot.service). Absent for a post with no specific date
   *  (e.g. a general nightlife/fashion recommendation). */
  activityDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const updateSchema = new Schema<IUpdate>({
  authorType: { type: String, enum: ['vendor', 'buyer'], required: true },
  authorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['video', 'image'], required: true },
  caption: { type: String, default: '', maxlength: 500 },
  hashtags: { type: [String], default: [], index: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', index: true },
  media: {
    type: [mediaSchema],
    required: true,
    validate: {
      validator: (v: unknown[]) => Array.isArray(v) && v.length >= 1 && v.length <= 5,
      message: 'media must have between 1 and 5 items',
    },
  },
  likeCount: { type: Number, default: 0 },
  saveCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'removed'], default: 'active', index: true },
  // Nullable moderation stamp — absent/null means "visible on Discover" (the
  // for-you query matches on `: null`, which Mongo's null-equality also
  // satisfies for posts predating this field). A Date takes it off Discover.
  hiddenFromDiscoverAt: { type: Date, default: null },
  hiddenFromDiscoverBy: { type: String, default: null },
  // `null` included in both enum arrays: Mongoose's enum validator runs
  // against the stored value even when the field's own `default` is null,
  // so an ordinary post (which never sets either field, relying purely on
  // the default) would otherwise fail validation on every single create().
  feature: { type: String, enum: ['whats-hot', null], default: null },
  hotCategory: { type: String, enum: [...WHATS_HOT_CATEGORIES, null], default: null },
  venue: { type: String, maxlength: 200, default: null },
  activityDate: { type: Date, default: null },
}, { timestamps: true });

updateSchema.index({ createdAt: -1 });
updateSchema.index({ authorType: 1, authorId: 1, createdAt: -1 });
updateSchema.index({ 'media.status': 1, status: 1, createdAt: -1 });
// Multikey: serves "recent visible updates for hashtag X" (future trending query).
updateSchema.index({ hashtags: 1, createdAt: -1 });
// Serves the What's Hot rail/See All queries (feature:'whats-hot', status
// active, media ready) sorted/filtered by category and activityDate.
updateSchema.index({ feature: 1, hotCategory: 1, activityDate: 1, createdAt: -1 });

export const Update = mongoose.model<IUpdate>('Update', updateSchema);
