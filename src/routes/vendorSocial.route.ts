import { Router } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { VendorSocialController } from '@controllers/vendorSocial.controller';
import { VendorConsumerReadsController } from '@controllers/vendorConsumerReads.controller';
import { StoryController } from '@controllers/story.controller';
import { AccountActivityController } from '@controllers/accountActivity.controller';

// Vendor (organizer brand) social-graph endpoints. Mounted at
// /api/tickets/social — see src/app.ts, placed before the broader
// /api/tickets mount so these specific paths aren't shadowed.
const router = Router();

router.get('/me', authenticateTickets, VendorSocialController.me);
// Brand nearby opt-in — exact path, registered before the '/users/:username'
// param route (which only captures the '/users' prefix, so no conflict).
router.patch('/me/location', authenticateTickets, VendorConsumerReadsController.updateLocation);
router.delete('/me/location', authenticateTickets, VendorConsumerReadsController.deleteLocation);
router.post('/follow', authenticateTickets, requireProfilePhoto, VendorSocialController.follow);
router.delete('/follow/:targetType/:targetId', authenticateTickets, VendorSocialController.unfollow);
router.get('/me/following', authenticateTickets, VendorSocialController.following);
router.get('/me/followers', authenticateTickets, VendorSocialController.followers);
// My Account tab (spec §1) — the organizer-brand twin of the buyer
// /api/social/me/account-activity mount in @routes/social.route. Same
// AccountActivityService (ownerId is actor-agnostic already), just entered
// through the vendor token so the owner is the brand, not a buyer.
router.get('/me/account-activity', authenticateTickets, AccountActivityController.listAsVendor);
router.post('/me/account-activity/read', authenticateTickets, AccountActivityController.markReadAsVendor);
router.post('/me/account-activity/read-all', authenticateTickets, AccountActivityController.markAllReadAsVendor);
// '/users/search' MUST be registered BEFORE '/users/:username' or "search" is captured as a username.
router.get('/users/search', authenticateTickets, VendorSocialController.searchUsers);
router.get('/users/:username', authenticateTickets, VendorSocialController.publicProfile);
router.get('/notifications', authenticateTickets, VendorSocialController.notifications);
router.post('/notifications/read', authenticateTickets, VendorSocialController.markNotificationsRead);
router.post('/block', authenticateTickets, VendorSocialController.blockUser);
router.delete('/block/:userId', authenticateTickets, VendorSocialController.unblockUser);

// Brand "who to follow / what's near me / for you" surfaces — the organizer
// equivalents of the buyer /api/social/{suggestions,recommendations,nearby}.
router.get('/suggestions/people', authenticateTickets, VendorConsumerReadsController.suggestedPeople);
router.get('/suggestions/organizers', authenticateTickets, VendorConsumerReadsController.suggestedOrganizers);
router.get('/recommendations', authenticateTickets, VendorConsumerReadsController.recommendations);
router.get('/nearby/people', authenticateTickets, VendorConsumerReadsController.nearbyPeople);
// The "Following" tab of the organizer Home feed — events by the organizers
// this brand follows. No collision with the '/me/following' account list
// above: that path is a literal with no param or wildcard, so it never
// captures this longer one.
router.get('/me/following/events', authenticateTickets, VendorConsumerReadsController.followingEvents);

// Brand status/stories — the organizer Home rail. Same StoryController as the
// buyer mount in @routes/social.route, entered through the vendor twins so the
// actor is the brand (Story.authorType 'vendor'); story.service was
// actor-shaped already, so nothing below the controller changed.
router.post('/stories', authenticateTickets, requireProfilePhoto, StoryController.createAsVendor);
router.post('/stories/:id/finalize', authenticateTickets, requireProfilePhoto, StoryController.finalizeAsVendor);
router.get('/stories', authenticateTickets, StoryController.listAsVendor);
router.post('/stories/:id/seen', authenticateTickets, StoryController.seenAsVendor);
router.post('/stories/:id/like', authenticateTickets, StoryController.likeAsVendor);
router.get('/stories/:id/viewers', authenticateTickets, StoryController.viewersAsVendor);
router.get('/stories/:id/likers', authenticateTickets, StoryController.likersAsVendor);
router.delete('/stories/:id', authenticateTickets, StoryController.removeAsVendor);

export default router;
