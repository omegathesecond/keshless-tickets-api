import mongoose, { Schema, Document, Types } from 'mongoose';
import type { UpdateAuthorType, UpdateKind, UpdateMedia } from '@interfaces/update.interface';
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
  /** Set the first time the caption is edited post-publish; stays set (to the
   *  latest edit time) after that. Null/absent means never edited — drives
   *  the "Edited" label next to the post's timestamp everywhere it appears. */
  editedAt?: Date | null;
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
  editedAt: { type: Date, default: null },
}, { timestamps: true });

updateSchema.index({ createdAt: -1 });
updateSchema.index({ authorType: 1, authorId: 1, createdAt: -1 });
updateSchema.index({ 'media.status': 1, status: 1, createdAt: -1 });
// Multikey: serves "recent visible updates for hashtag X" (future trending query).
updateSchema.index({ hashtags: 1, createdAt: -1 });

export const Update = mongoose.model<IUpdate>('Update', updateSchema);
