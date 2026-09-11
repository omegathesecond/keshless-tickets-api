import mongoose, { Schema, Document, Types } from 'mongoose';
import { mediaSchema } from '@models/shared/media.schema';
import type { StoryAuthorType, StoryKind, StoryMedia } from '@interfaces/story.interface';
import type { IfIGoAudience } from '@interfaces/ifIGo.interface';

/** A handful of fixed Carrot-branded backgrounds a creator can pick instead
 *  of (or behind) media — spec §1.2 "Add an optional photo, video,
 *  background or caption." Kept tiny and closed (not free-form colors) so
 *  every If I Go card stays on-brand without needing a color picker. */
export const IF_I_GO_BACKGROUND_PRESETS = ['carrot_orange', 'carrot_gradient', 'charcoal', 'cream'] as const;
export type IfIGoBackgroundPreset = (typeof IF_I_GO_BACKGROUND_PRESETS)[number];

/**
 * Ephemeral 24h media post (Instagram/WhatsApp-style "Story"). Author is a
 * buyer or an organizer brand (Vendor) — same author vocabulary as Update
 * (@models/update.model). `expiresAt` is set at create time
 * (createdAt + 24h, see story.service#createStory) and the TTL index below
 * makes Mongo auto-delete the document once it passes — no cron/sweep needed
 * for cleanup. Reads still filter `expiresAt: {$gt: now}` explicitly (see
 * story.service#listForViewer) since the TTL monitor only runs ~once/60s and
 * must not be relied on for read-time correctness.
 *
 * `audience`/`caption`/`background` exist for the 'if_i_go' kind only (spec:
 * If I Go… §1) — left undefined (and unused) by the plain image/video flow,
 * so nothing about existing Story behavior changes. The If I Go poll itself
 * (question/options/responses) is NOT stored here — see
 * @models/ifIGoStory.model for why it needs to outlive this ephemeral doc.
 */
export interface IStory extends Document {
  authorType: StoryAuthorType;
  authorId: Types.ObjectId;
  kind: StoryKind;
  /** Required for 'image'/'video' kinds; optional for 'if_i_go' (which may
   *  ship with no media at all — a background + caption only). */
  media?: StoryMedia;
  /** 'if_i_go' only, and only set when `media` was requested at creation —
   *  tells finalize which branch of story.service#finalizeMediaOnStory to
   *  run, since `kind` itself stays 'if_i_go' either way (unlike a plain
   *  Story, where `kind` IS the media type). */
  mediaKind?: 'image' | 'video';
  /** 'if_i_go' only. Who may view/respond beyond the default global Story
   *  audience — 'followers' narrows visibility to the creator's followers
   *  (see story.service#listForViewer). Undefined behaves as 'everyone'. */
  audience?: IfIGoAudience;
  /** 'if_i_go' only — optional caption shown under the question. */
  caption?: string;
  /** 'if_i_go' only, mutually exclusive-in-practice with `media` (a creator
   *  may still set both; media wins visually) — a flat brand-color backdrop
   *  when no photo/video was attached. */
  background?: { preset: IfIGoBackgroundPreset };
  createdAt: Date;
  expiresAt: Date;
}

const storySchema = new Schema<IStory>({
  authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
  authorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['image', 'video', 'if_i_go'], required: true },
  // Conditionally required: every existing 'image'/'video' write path already
  // always supplies media (see story.service#createStory), so this is a
  // behavior-preserving relaxation for the ONE new case that legitimately has
  // none — a background-only If I Go card.
  media: { type: mediaSchema, required: function (this: IStory) { return this.kind !== 'if_i_go'; } },
  mediaKind: { type: String, enum: ['image', 'video'] },
  audience: { type: String, enum: ['everyone', 'followers'] },
  caption: { type: String, trim: true, maxlength: 200 },
  background: {
    preset: { type: String, enum: IF_I_GO_BACKGROUND_PRESETS },
  },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Auto-expiry: Mongo's TTL monitor deletes a document once expiresAt is in
// the past (expireAfterSeconds:0 means "at expiresAt itself", not an offset).
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// An author's own stories, newest first (profile "My Story" tray).
storySchema.index({ authorType: 1, authorId: 1, createdAt: -1 });

export const Story = mongoose.model<IStory>('Story', storySchema);
