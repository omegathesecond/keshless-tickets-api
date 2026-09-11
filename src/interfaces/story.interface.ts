import type { UpdateMedia } from '@interfaces/update.interface';

export type StoryAuthorType = 'buyer' | 'vendor';
/** 'if_i_go' (spec: If I Go…) carries no media of its own kind — its OPTIONAL
 *  attached photo/video is tracked separately via IfIGoStory.mediaKind, since
 *  the interactive card can also ship with just a background + caption (see
 *  @models/ifIGoStory.model). */
export type StoryKind = 'image' | 'video' | 'if_i_go';

/** Stories reuse the exact same media sub-shape Updates use (raw upload ->
 *  processing -> ready/failed, image or video rendition). See
 *  @models/shared/media.schema for the Mongo-side schema this mirrors. */
export type StoryMedia = UpdateMedia;
