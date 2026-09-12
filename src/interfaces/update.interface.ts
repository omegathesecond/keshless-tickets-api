export type UpdateAuthorType = 'vendor' | 'buyer';
export type UpdateKind = 'video' | 'image';
export type UpdateMediaStatus = 'processing' | 'ready' | 'failed';

/** Section membership for a post beyond the plain feed/profile/event
 *  destinations every Update already publishes to. Currently just "What's
 *  Hot This Weekend" (spec: promoting upcoming-weekend content) — an Update
 *  with `feature: 'whats-hot'` is a completely normal post everywhere else
 *  (profile grid, event Posts tab, Discover) and ADDITIONALLY eligible for
 *  the What's Hot rail/See All page while its weekend hasn't ended yet (see
 *  @services/whatsHot.service). */
export type UpdateFeature = 'whats-hot';

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
