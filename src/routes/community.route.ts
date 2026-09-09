import { Router } from 'express';
import { authenticateBuyer, authenticateCommunityViewer, optionalCommunityViewer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { CommunityController } from '@controllers/community.controller';
import { MessageController } from '@controllers/message.controller';
import { ReportController } from '@controllers/report.controller';
import { EventQuestionController } from '@controllers/eventQuestion.controller';
import { TopicsMineController } from '@controllers/topicsMine.controller';

const router = Router();

// channel/message/questions routes are registered BEFORE the /:eventId routes
// so the literal 'channels'/'messages'/'reports'/'questions' prefixes can
// never be captured by :eventId. For /questions/:questionId/... this is only
// a consistency choice, not a structural necessity: those paths are 3
// segments long ('questions', :questionId, 'replies'|'like') while every
// /:eventId route below is 1-2 segments, so segment count alone already
// disambiguates them regardless of registration order.
//
// Community membership is polymorphic now: a buyer OR an organizer brand can
// join and post. So read AND write routes both use authenticateCommunityViewer
// (buyer OR vendor/sub-user token); the controllers resolve a SocialActor and
// enforce membership per-handler (a non-member — brand or buyer — is 403'd by
// requireChannelAccess). A managing brand that hasn't joined still gets the
// read-only ownership-gated peek on the READ paths. verify-ticket + reports
// stay authenticateBuyer — a brand holds no ticket and buyer-reporting is a
// buyer concept.

router.get('/channels/:channelId/messages', authenticateCommunityViewer, MessageController.list);
router.post('/channels/:channelId/messages', authenticateCommunityViewer, requireProfilePhoto, MessageController.send);
router.post('/channels/:channelId/read', authenticateCommunityViewer, MessageController.markRead);
router.get('/channels/:channelId/pins', authenticateCommunityViewer, MessageController.listPins);
router.delete('/messages/:messageId', authenticateCommunityViewer, MessageController.deleteOwn);

/**
 * Buyer report filing — a message or another buyer. Admin review lives at
 * GET/POST /api/tickets/reports* (tickets:moderate_social), see tickets.route.ts.
 */
router.post('/reports', authenticateBuyer, ReportController.file);

/**
 * Event Q&A (TopicsPage discussion threads) — questions + replies + likes.
 * optionalTicketsAuth accepts a buyer OR vendor token, or no token at all;
 * the controller resolves the SocialActor and 401s writes itself when one
 * doesn't resolve, so anonymous callers can still GET the thread.
 */
// "YOUR TOPICS" — the actor's own topics + per-topic read cursor. Registered
// before the /questions/:questionId writes: 'mine' is a literal 2-segment GET
// that must never be captured as a :questionId. Both 401 without an actor.
router.get('/questions/mine', optionalTicketsAuth, TopicsMineController.listMine);
// General "Chat with Everyone" post — not scoped to an event. A literal
// 1-segment POST, so it never collides with the 2-segment GET below.
router.post('/questions', optionalTicketsAuth, requireProfilePhoto, EventQuestionController.createGeneral);
// Single topic (conversation page). After /questions/mine so the literal wins;
// a 2-segment GET that never collides with the 3-segment POSTs below.
router.get('/questions/:questionId', optionalTicketsAuth, EventQuestionController.get);
router.post('/questions/:questionId/read', optionalTicketsAuth, TopicsMineController.markRead);

router.post('/questions/:questionId/replies', optionalTicketsAuth, requireProfilePhoto, EventQuestionController.reply);
router.post('/questions/:questionId/like', optionalTicketsAuth, requireProfilePhoto, EventQuestionController.like);

router.post('/:eventId/join', authenticateCommunityViewer, requireProfilePhoto, CommunityController.join);
// Who's-going social proof is public: optionalCommunityViewer lets signed-out
// visitors read the community view + roster (join/messages stay gated).
router.get('/:eventId', optionalCommunityViewer, CommunityController.getView);
router.post('/:eventId/verify-ticket', authenticateBuyer, CommunityController.reverifyTicket);
router.get('/:eventId/members', optionalCommunityViewer, CommunityController.listMembers);
router.get('/:eventId/questions', optionalTicketsAuth, EventQuestionController.list);
router.post('/:eventId/questions', optionalTicketsAuth, requireProfilePhoto, EventQuestionController.create);

export default router;
