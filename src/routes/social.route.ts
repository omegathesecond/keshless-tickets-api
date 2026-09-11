import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { SocialProfileController } from '@controllers/socialProfile.controller';
import { ConsumerReadsController } from '@controllers/consumerReads.controller';
import { StoryController } from '@controllers/story.controller';
import { IfIGoController } from '@controllers/ifIGo.controller';
import { MeetupController } from '@controllers/meetup.controller';
import { AccountActivityController } from '@controllers/accountActivity.controller';

const router = Router();

router.get('/me', authenticateBuyer, SocialProfileController.me);
router.get('/me/saved', authenticateBuyer, ConsumerReadsController.mySaved);
router.get('/me/going', authenticateBuyer, ConsumerReadsController.myGoing);
router.get('/me/calendar', authenticateBuyer, ConsumerReadsController.myCalendar);
router.get('/me/following/events', authenticateBuyer, ConsumerReadsController.myFollowingEvents);
router.patch('/me', authenticateBuyer, SocialProfileController.update);
router.get('/me/blocks', authenticateBuyer, SocialProfileController.myBlocks);
router.get('/me/following', authenticateBuyer, SocialProfileController.myFollowing);
router.get('/me/followers', authenticateBuyer, SocialProfileController.myFollowers);
router.get('/me/friends', authenticateBuyer, SocialProfileController.myFriends);
router.patch('/me/location', authenticateBuyer, SocialProfileController.updateLocation);
router.delete('/me/location', authenticateBuyer, SocialProfileController.deleteLocation);
router.get('/notifications', authenticateBuyer, SocialProfileController.myNotifications);
router.post('/notifications/read', authenticateBuyer, SocialProfileController.markNotificationsRead);
// My Account tab (Activity page) — grouped account-insight events, distinct
// from the /notifications inbox above (spec §2, never the same rows).
router.get('/me/account-activity', authenticateBuyer, AccountActivityController.list);
router.post('/me/account-activity/read', authenticateBuyer, AccountActivityController.markRead);
router.post('/me/account-activity/read-all', authenticateBuyer, AccountActivityController.markAllRead);
router.get('/username-available', authenticateBuyer, SocialProfileController.usernameAvailable);
router.post('/follow', authenticateBuyer, requireProfilePhoto, SocialProfileController.followTarget);
router.delete('/follow/:targetType/:targetId', authenticateBuyer, SocialProfileController.unfollowTarget);
// Follower/following lists are PUBLIC social data — optional auth so
// anonymous visitors and signed-in vendors (viewing their own brand's
// Followers/Following) both get the list. isFollowing is only resolved
// for a BUYER viewer (see SocialProfileController.followersList).
router.get('/followers/:targetType/:targetId', optionalTicketsAuth, SocialProfileController.followersList);
router.get('/following/:targetType/:targetId', optionalTicketsAuth, SocialProfileController.followingList);
router.post('/block', authenticateBuyer, SocialProfileController.blockUser);
router.post('/presence', authenticateBuyer, SocialProfileController.presence);
router.delete('/block/:userId', authenticateBuyer, SocialProfileController.unblockUser);
router.get('/suggestions/people', authenticateBuyer, ConsumerReadsController.suggestedPeople);
router.get('/suggestions/organizers', authenticateBuyer, ConsumerReadsController.suggestedOrganizers);
router.get('/recommendations', authenticateBuyer, ConsumerReadsController.recommendations);
router.get('/nearby/people', authenticateBuyer, ConsumerReadsController.nearbyPeople);
router.post('/meetups', authenticateBuyer, requireProfilePhoto, MeetupController.request);
router.get('/meetups', authenticateBuyer, MeetupController.list);
router.post('/meetups/:id/accept', authenticateBuyer, MeetupController.accept);
router.post('/meetups/:id/decline', authenticateBuyer, MeetupController.decline);
router.delete('/meetups/:id', authenticateBuyer, MeetupController.cancel);
// Ephemeral 24h Stories — registered above '/users/:username' alongside the
// rest of the fixed-segment routes, same reasoning as '/users/search' below.
router.post('/stories', authenticateBuyer, requireProfilePhoto, StoryController.create);
router.post('/stories/:id/finalize', authenticateBuyer, requireProfilePhoto, StoryController.finalize);
router.get('/stories', authenticateBuyer, StoryController.list);
router.post('/stories/:id/seen', authenticateBuyer, StoryController.seen);
router.post('/stories/:id/like', authenticateBuyer, StoryController.like);
router.get('/stories/:id/viewers', authenticateBuyer, StoryController.viewers);
router.get('/stories/:id/likers', authenticateBuyer, StoryController.likers);
router.delete('/stories/:id', authenticateBuyer, StoryController.remove);
// "If I Go…" — an interactive Story type (spec: If I Go…). Buyer-only, so
// no vendor twin (unlike the plain Story routes above). GET is
// optionalTicketsAuth: an anonymous viewer can still see public results,
// gated inside the service by audience/block/expiry rules.
router.post('/stories/if-i-go', authenticateBuyer, requireProfilePhoto, IfIGoController.create);
router.post('/stories/:id/if-i-go/finalize', authenticateBuyer, requireProfilePhoto, IfIGoController.finalize);
router.get('/stories/:id/if-i-go', optionalTicketsAuth, IfIGoController.get);
router.post('/stories/:id/if-i-go/respond', authenticateBuyer, IfIGoController.respond);
router.delete('/stories/:id/if-i-go/respond', authenticateBuyer, IfIGoController.removeResponse);
router.patch('/stories/:id/if-i-go/responses-enabled', authenticateBuyer, IfIGoController.setResponsesEnabled);
router.get('/stories/:id/if-i-go/respondents', authenticateBuyer, IfIGoController.respondents);
router.delete('/stories/:id/if-i-go/respondents/:respondentId', authenticateBuyer, IfIGoController.removeRespondent);
router.post('/stories/:id/if-i-go/respondents/:respondentId/status', authenticateBuyer, IfIGoController.setResponseStatus);
router.post('/stories/:id/if-i-go/confirm-ticket', authenticateBuyer, IfIGoController.confirmTicket);
router.post('/stories/:id/if-i-go/message', authenticateBuyer, IfIGoController.openConversation);
router.get('/stories/:id/if-i-go/plans', authenticateBuyer, IfIGoController.plans);
// '/users/search' MUST be registered BEFORE '/users/:username' or "search" is captured as a username.
router.get('/users/search', authenticateBuyer, SocialProfileController.searchUsers);
router.get('/users/:username', authenticateBuyer, SocialProfileController.publicProfile);
router.get('/push/vapid-public-key', authenticateBuyer, SocialProfileController.vapidPublicKey);
router.post('/push/subscribe', authenticateBuyer, SocialProfileController.pushSubscribe);
router.delete('/push/subscribe', authenticateBuyer, SocialProfileController.pushUnsubscribe);

export default router;
