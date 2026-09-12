export type UpdateAuthorType = 'vendor' | 'buyer';
export type UpdateKind = 'video' | 'image';
export type UpdateMediaStatus = 'processing' | 'ready' | 'failed';

/** Content category, distinct from `kind` (which is media-shape only).
 *  'general' is the default for every ordinary post; 'weekend_recap' opts a
 *  post into the Weekend Recap Home-feed section/See-All page while it stays
 *  a completely normal Update everywhere else (Discover, profile, event
 *  Posts tab, moderation, reactions). */
export const UPDATE_CATEGORIES = ['general', 'weekend_recap'] as const;
export type UpdateCategory = (typeof UPDATE_CATEGORIES)[number];

export interface UpdateVideoMedia {
  url: string;          // 720p mp4 (primary)
  url480?: string;      // 480p mp4 (low-bandwidth)
  poster: string;       // JPG poster
  width: number;
  height: number;
  durationSec: number;
}
export interface UpdateImageMedia {
  url: string;
  width: number;
  height: number;
}
export interface UpdateMedia {
  rawKey: string;
  status: UpdateMediaStatus;
  video?: UpdateVideoMedia;
  image?: UpdateImageMedia;
  error?: string;
  processingStartedAt?: Date;   // for the reconcile sweep
}
// Update.media is a 1..5 item carousel (photos-only; a video post is always
// a length-1 array — see update.model.ts's validator). Story.media stays a
// single embedded UpdateMedia — do not change StoryMedia's cardinality.
