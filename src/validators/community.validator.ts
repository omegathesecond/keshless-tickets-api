import Joi from 'joi';

export const sendMessageSchema = Joi.object({
  body: Joi.string().trim().min(1).max(2000).required(),
  replyTo: Joi.string().hex().length(24).optional(),
});

export const updateProfileSchema = Joi.object({
  username: Joi.string().optional(),
  name: Joi.string().trim().min(1).max(100).optional(),
  bio: Joi.string().allow('').max(280).optional(),
  dmPrivacy: Joi.string().valid('community', 'friends').optional(),
  activityViewHistoryDisabled: Joi.boolean().optional(),
  notificationPrefs: Joi.object({
    announcements: Joi.boolean(),
    dms: Joi.boolean(),
    mentions: Joi.boolean(),
    social: Joi.boolean(),
    reminders: Joi.boolean(),
  }).min(1).optional(),
}).min(1);

export const blockSchema = Joi.object({
  userId: Joi.string().hex().length(24).required(),
});

export const followSchema = Joi.object({
  targetType: Joi.string().valid('buyer', 'organizer').required(),
  targetId: Joi.string().hex().length(24).required(),
});

export const createThreadSchema = Joi.object({
  participantIds: Joi.array().items(Joi.string().hex().length(24)).min(1).max(9).required(),
});

export const openBrandThreadSchema = Joi.object({
  vendorId: Joi.string().hex().length(24).required(),
});

export const organizerProfileSchema = Joi.object({
  logoUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(500).allow('').optional(),
  bio: Joi.string().max(500).allow('').optional(),
}).min(1);

export const reviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  text: Joi.string().trim().max(1000).allow('').optional(),
});

export const reviewReplySchema = Joi.object({
  text: Joi.string().trim().min(1).max(1000).required(),
});

export const announcementSchema = Joi.object({
  body: Joi.string().trim().min(1).max(2000).required(),
});

export const createChannelSchema = Joi.object({
  name: Joi.string().trim().min(1).max(40).required(),
  gated: Joi.boolean().optional(),
  postPolicy: Joi.string().valid('all', 'organizer').optional(),
});

export const updateChannelSchema = Joi.object({
  name: Joi.string().trim().min(1).max(40).optional(),
  gated: Joi.boolean().optional(),
  postPolicy: Joi.string().valid('all', 'organizer').optional(),
  archived: Joi.boolean().optional(),
}).min(1);

export const muteSchema = Joi.object({
  minutes: Joi.number().integer().min(5).max(10080).required(),
});

export const reportSchema = Joi.object({
  targetType: Joi.string().valid('message', 'buyer').required(),
  messageId: Joi.string()
    .hex()
    .length(24)
    .when('targetType', { is: 'message', then: Joi.required(), otherwise: Joi.forbidden() }),
  targetBuyerId: Joi.string()
    .hex()
    .length(24)
    .when('targetType', { is: 'buyer', then: Joi.required(), otherwise: Joi.forbidden() }),
  reason: Joi.string().trim().min(1).max(500).required(),
});

export const resolveReportSchema = Joi.object({
  action: Joi.string().valid('delete_message', 'suspend_buyer', 'unsuspend_buyer', 'dismiss').required(),
  note: Joi.string().trim().max(500).allow('').optional(),
});

export const presenceSchema = Joi.object({
  buyerIds: Joi.array().items(Joi.string().hex().length(24)).min(1).max(50).required(),
});

export const locationSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
});

export const pushSubscribeSchema = Joi.object({
  endpoint: Joi.string().uri({ scheme: ['https'] }).max(1000).required(),
  keys: Joi.object({
    p256dh: Joi.string().max(300).required(),
    auth: Joi.string().max(300).required(),
  }).required(),
});
