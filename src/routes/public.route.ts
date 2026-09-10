import { Router } from 'express';
import { PublicController } from '@controllers/public.controller';
import { BuyerProfileController } from '@controllers/buyerProfile.controller';
import { ReviewController } from '@controllers/review.controller';
import { EventReactionController } from '@controllers/eventReaction.controller';
import { OrganizerProfileController } from '@controllers/organizerProfile.controller';
import { ServicesController } from '@controllers/services.controller';
import { ServiceCategoryController } from '@controllers/serviceCategory.controller';
import { EnquiryController } from '@controllers/enquiry.controller';
import { FeedController } from '@controllers/feed.controller';
import { UpdateController } from '@controllers/update.controller';
import { EventQuestionController } from '@controllers/eventQuestion.controller';
import { TicketPdfController } from '@controllers/ticketPdf.controller';
import { MenuPublicController } from '@controllers/menuPublic.controller';
import { authenticateBuyer, authenticateBuyerOrOrganizer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { avatarUpload, communityEventUpload, handleMulterError, validateFileUpload } from '@middleware/media.middleware';
import { CommunityEventSubmitController } from '@controllers/communityEventSubmit.controller';
import { VoteController } from '@controllers/vote.controller';

const router = Router();

/**
 * Public Routes - No authentication required
 * These endpoints allow public access to browse events and purchase tickets
 */

/**
 * @route   GET /api/public/payment-methods
 * @desc    Returns the payment methods the buyer checkout may show.
 *          A method is listed iff its admin toggle is ON and it is configured.
 *          MoMo additionally requires MTN_MOMO_ENABLED=true in the environment.
 *          Cash is excluded — it is a POS/outlet-only method.
 * @access  Public
 */
router.get('/payment-methods', PublicController.getPaymentMethods);

/**
 * @route   GET /api/public/events
 * @desc    Get all published events (paginated)
 * @access  Public
 * @query   page, limit, search, startDate, endDate
 */
router.get('/events', PublicController.getPublicEvents);

/**
 * @route   GET /api/public/calendar
 * @desc    Every published event in a year, grouped by month ("what's on").
 *          Optional auth only marks the viewer's going/saved rows — it never
 *          changes which events are returned.
 * @access  Public
 * @query   year (defaults to the current UTC year)
 */
router.get('/calendar', optionalTicketsAuth, PublicController.getPublicCalendar);

/**
 * @route   GET /api/public/activity
 * @desc    Recent REAL purchase activity across published events for the live
 *          FOMO ticker. Names are masked to "Sipho D."; returns [] when quiet.
 * @access  Public
 * @query   limit (1–30, default 15)
 */
router.get('/activity', PublicController.getActivity);

/**
 * @route   GET /api/public/activity-feed
 * @desc    The Activity page feed — real likes, follows, going, posts and
 *          event announcements across the platform, newest first. Public;
 *          ?tab=following requires a buyer session.
 * @access  Public
 */
router.get('/activity-feed', optionalTicketsAuth, PublicController.getActivityFeed);

/**
 * @route   GET /api/public/trending
 * @desc    Trending hashtags for the TopicsPage rail, ranked by post volume
 *          over the last 14 days across active, ready updates. Top 3 are
 *          flagged `hot`. Returns { trending: [] } when there's no recent
 *          hashtagged activity — never fabricated.
 * @access  Public
 */
router.get('/trending', PublicController.getTrending);

/**
 * @route   GET /api/public/topics/:tag/posts
 * @desc    Visible posts for one hashtag (TopicsPage tag detail), newest
 *          first. Same visibility filter as /trending (active status, ready
 *          media) and the same per-post DTO as
 *          /updates/by/:authorType/:authorId and /updates/for-event/:eventId
 *          (UpdateController.dto). Returns { posts: [], tag, page, hasMore }
 *          when there are no visible posts — never fabricated.
 * @access  Public (optional tickets token for viewerReactions)
 * @query   page (default 1), limit (1-50, default 20)
 */
router.get('/topics/:tag/posts', optionalTicketsAuth, PublicController.getTopicPosts);

/**
 * @route   GET /api/public/questions
 * @desc    Cross-event Q&A: the most recent questions across ALL events,
 *          newest first, each carrying its event { id, name } — powers the
 *          TopicsPage discussion list (per-event threads are still
 *          GET /api/community/:eventId/questions). Returns { questions: [] }
 *          when there are none — never fabricated.
 * @access  Public (optional tickets token for viewerHasLiked)
 * @query   limit (default 20)
 */
router.get('/questions', optionalTicketsAuth, EventQuestionController.listRecent);

/**
 * @route   GET /api/public/feed
 * @desc    Discover feed — a blended stream of buyer/organizer updates,
 *          upcoming published events, and real purchase activity. If a
 *          buyer token is present, update slides carry viewerReactions.
 * @access  Public (optional buyer auth)
 * @query   tab (for-you|following|events, default for-you), cursor,
 *          category (chip filter; absent or 'All' = unfiltered)
 */
router.get('/feed', optionalTicketsAuth, FeedController.get);

/**
 * @route   GET /api/public/updates/by/:authorType/:authorId
 * @desc    An author's own ready updates, newest first (profile grid: the
 *          organizer "Posts" tab and buyer posts). Reached via fallthrough
 *          from the narrower /api/public/updates mount (@routes/update.route
 *          only claims single-segment /:id paths) — see src/app.ts mount
 *          order comments.
 * @access  Public (optional tickets token for viewerReactions)
 * @query   cursor (createdAt ISO string of the last item on the prior page)
 */
router.get('/updates/by/:authorType/:authorId', optionalTicketsAuth, UpdateController.listByAuthor);

/**
 * @route   GET /api/public/updates/for-event/:eventId
 * @desc    Posts tagged to one event, newest first — the Media tab on the
 *          event quick-view (attendees sharing photos/videos from that show).
 * @access  Public (optional tickets token for viewerReactions)
 * @query   cursor (createdAt ISO string of the last item on the prior page)
 */
router.get('/updates/for-event/:eventId', optionalTicketsAuth, UpdateController.listByEvent);

/**
 * Vote (spec: event-engagement voting feature). Event-detail page (§3) +
 * Home feed cards (§4) read this; casting a vote, suggesting a song, tagging
 * an attendee and joining the discussion all require a signed-in buyer (§5,
 * §2, §7) — matching the meetup/story write routes above.
 */
router.get('/events/:eventId/vote', optionalTicketsAuth, VoteController.get);
router.post('/events/:eventId/vote/:questionId', authenticateBuyer, VoteController.cast);
router.post('/events/:eventId/vote/:questionId/songs', authenticateBuyer, VoteController.suggestSong);
router.post('/events/:eventId/vote/:questionId/tags', authenticateBuyer, VoteController.requestTag);
router.post('/vote-tags/:tagId/confirm', authenticateBuyer, VoteController.confirmTag);
router.post('/vote-tags/:tagId/decline', authenticateBuyer, VoteController.declineTag);
router.delete('/vote-tags/:tagId', authenticateBuyer, VoteController.removeTag);
router.get('/vote-questions/:questionId/comments', optionalTicketsAuth, VoteController.listComments);
router.post('/vote-questions/:questionId/comments', authenticateBuyerOrOrganizer, VoteController.postComment);
router.post('/vote-comments/:commentId/react', authenticateBuyerOrOrganizer, VoteController.reactToComment);
router.delete('/vote-comments/:commentId', authenticateBuyerOrOrganizer, VoteController.deleteComment);

/**
 * @route   GET /api/public/events/live
 * @desc    Published events currently in progress (startTime <= now <= endTime),
 *          sorted by startTime, each carrying a REAL `liveAttendees` count
 *          (active community members). Powers the Home "Live Now" rail.
 *          Registered ABOVE /events/:eventId so "live" is never captured as
 *          an eventId param.
 * @access  Public
 */
router.get('/events/live', PublicController.getLiveEvents);

/**
 * @route   GET /api/public/events/:eventId
 * @desc    Get single published event details
 * @access  Public
 */
router.get('/events/:eventId', PublicController.getPublicEvent);

/**
 * @route   GET /api/public/events/:eventId/menu
 * @desc    Active bar/vendor menu items for the event's Menu tab, plus the
 *          preorder payment methods available and the current Carrot
 *          service-charge percentage.
 * @access  Public
 */
router.get('/events/:eventId/menu', MenuPublicController.getEventMenu);

/**
 * @route   POST /api/public/events/:eventId/menu-orders
 * @desc    Place a bar/vendor preorder. keshless_wallet resolves synchronously
 *          (card number + PIN for >= E50); mtn_momo returns a referenceId to
 *          poll. Identity comes from the buyer token, never the body.
 * @access  Buyer (Bearer buyer token)
 * @body    items: [{ menuItemId, quantity }], paymentMethod, keshlessCardNumber?, keshlessPin?, momoPhone?, notes?
 */
router.post('/events/:eventId/menu-orders', authenticateBuyer, MenuPublicController.createOrder);

/**
 * @route   GET /api/public/menu-orders/momo/:referenceId/status
 * @desc    Poll a pending MoMo preorder; finalizes when MTN reports SUCCESSFUL.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/menu-orders/momo/:referenceId/status', authenticateBuyer, MenuPublicController.getMomoOrderStatus);

/**
 * @route   GET /api/public/my-menu-orders
 * @desc    The signed-in buyer's Menu preorder history.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/my-menu-orders', authenticateBuyer, MenuPublicController.getMyOrders);

/**
 * @route   GET /api/public/events/:eventId/reviews
 * @desc    Aggregate rating + paginated review list for an event page.
 * @access  Public
 * @query   before, limit
 */
router.get('/events/:eventId/reviews', ReviewController.listForEvent);

/**
 * @route   POST /api/public/events/:eventId/reviews
 * @desc    Submit a verified post-event review. Only ticket holders of an
 *          event that has ended may post, one review per buyer per event.
 * @access  Buyer (Bearer buyer token)
 * @body    rating (1-5), text?
 */
// Community self-listing: a signed-in buyer lists an event (poster + media).
// Reuses the dashboard creation path, but publishes immediately — no admin
// review, because a community listing sells no tickets (see the controller).
router.post('/events/submit', authenticateBuyer, communityEventUpload, handleMulterError, CommunityEventSubmitController.submit);

router.post('/events/:eventId/reviews', authenticateBuyer, requireProfilePhoto, ReviewController.submit);

/**
 * @route   POST /api/public/events/:eventId/like
 * @desc    Toggle the signed-in actor's like on an event (Discover event slides).
 * @access  Buyer or vendor session required — 401 when anonymous.
 */
router.post('/events/:eventId/like', optionalTicketsAuth, requireProfilePhoto, EventReactionController.like);

/**
 * @route   POST /api/public/events/:eventId/save
 * @desc    Toggle the signed-in actor's bookmark (Save) on an event — a
 *          distinct reaction from `like`, powering the Saved tab.
 * @access  Buyer or vendor session required — 401 when anonymous.
 */
router.post('/events/:eventId/save', optionalTicketsAuth, EventReactionController.save);

/**
 * @route   POST /api/public/events/:eventId/share
 * @desc    Record an event share. Anonymous allowed — sharing needs no actor.
 * @access  Public
 */
router.post('/events/:eventId/share', optionalTicketsAuth, EventReactionController.share);

/**
 * @route   GET /api/public/organizers/:vendorId
 * @desc    Public organizer brand page — business card, follower count,
 *          rating aggregate, and upcoming/past event lists. Never exposes
 *          email/phoneNumber/keshlessVendorId.
 * @access  Public
 */
router.get('/organizers/:vendorId', OrganizerProfileController.publicProfile);

/**
 * @route   GET /api/public/service-categories
 * @desc    Active, DB-driven service-business categories (sound hire,
 *          catering, decor, ...), sorted by admin order then label. Powers
 *          the SERVICES signup form's category picker and the /services
 *          directory's category filter chip list.
 * @access  Public
 */
router.get('/service-categories', ServiceCategoryController.listActive);

/**
 * @route   GET /api/public/services
 * @desc    Services directory — verified SERVICES-operatorType vendors as
 *          cards, newest first. Query: category, search, before (cursor id),
 *          limit (default 24, max 50).
 * @access  Public
 */
router.get('/services', ServicesController.directory);

/**
 * @route   GET /api/public/services/:businessId
 * @desc    Single services business profile. 404 for anything not a
 *          verified SERVICES vendor. Registered AFTER the static
 *          '/services' route above — order matters in Express.
 * @access  Public
 */
router.get('/services/:businessId', ServicesController.profile);

/**
 * @route   POST /api/public/services/:businessId/enquiries
 * @desc    Submit a lead/enquiry to a verified SERVICES business. Also
 *          establishes proof-of-contact (unlocks a review later — Task E2).
 * @access  Buyer (Bearer buyer token)
 * @body    message (required, max 1000), eventDate?, eventType?, contactPhone?, contactEmail?
 */
router.post('/services/:businessId/enquiries', authenticateBuyer, EnquiryController.create);

/**
 * @route   GET /api/public/services/:businessId/reviews
 * @desc    Paginated review list for a services business (eventId absent —
 *          disjoint from GET /events/:eventId/reviews).
 * @access  Public
 * @query   before, limit
 */
router.get('/services/:businessId/reviews', ServicesController.listReviews);

/**
 * @route   POST /api/public/services/:businessId/reviews
 * @desc    Submit a review of a services business. A BUYER is gated on
 *          proof-of-contact (must have enquired — 403 otherwise); a signed-in
 *          ORGANIZER (vendor) may review any business freely EXCEPT its own.
 *          One review per reviewer per business.
 * @access  Buyer OR organizer (Bearer token)
 * @body    rating (1-5), text?
 */
router.post('/services/:businessId/reviews', authenticateBuyerOrOrganizer, ServicesController.submitReview);

/**
 * @route   POST /api/public/purchase
 * @desc    Buy tickets using a Keshless card. The buyer must first prove
 *          ownership of their phone via the OTP login below — the ticket is
 *          tied to that VERIFIED phone (taken from the token, never the body),
 *          so it always shows up under "My Tickets" for the same number.
 * @access  Buyer (Bearer buyer token). Keshless card number + PIN for >= E50.
 * @body    eventId, ticketTypeId, quantity, customerName?, keshlessCardNumber, keshlessPin?
 */
router.post('/purchase', authenticateBuyer, PublicController.purchaseTickets);

/**
 * @route   POST /api/public/purchase/free
 * @desc    Claim a FREE ticket (a tier priced at 0). No payment method — the
 *          server re-verifies the tier is genuinely free, so a paid tier can
 *          never be obtained through this endpoint.
 * @access  Buyer (Bearer buyer token). Identity from the token, never the body.
 * @body    eventId, ticketTypeId, quantity, customerName?
 */
router.post('/purchase/free', authenticateBuyer, PublicController.claimFreeTicket);

/**
 * Buyer (ticket-holder) authentication.
 *
 * Returning buyers sign in with identifier + password (/auth/login), where
 * identifier is EITHER an email address OR a phone number — classified
 * automatically (email vs SMS channel). First-time registration is
 * OTP-gated: /auth/login returns { requiresRegistration: true } for an
 * unknown identifier, the client requests a code sent over the matching
 * channel (/auth/request-otp), then creates the account with code + password
 * (/auth/register). This proves ownership of the email or phone once, at
 * account creation, then relies on the password.
 * @route   POST /api/public/auth/login           { identifier, password }              -> { requiresRegistration, channel } | { accessToken, identity }
 * @route   POST /api/public/auth/request-otp     { identifier }                        -> sends code via email or SMS (new identifiers only)
 * @route   POST /api/public/auth/register        { identifier, code, password, name? } -> { accessToken, identity }
 * @route   POST /api/public/auth/forgot-password { identifier }                        -> sends reset code via email or SMS (existing identifiers only)
 * @route   POST /api/public/auth/reset-password  { identifier, code, password }        -> { accessToken, identity }
 */
router.post('/auth/login', PublicController.loginBuyer);
router.post('/auth/request-otp', PublicController.requestBuyerRegistrationOtp);
router.post('/auth/register', PublicController.registerBuyer);
router.post('/auth/forgot-password', PublicController.forgotPasswordBuyer);
router.post('/auth/reset-password', PublicController.resetPasswordBuyer);

/**
 * @route   GET /api/public/my-tickets
 * @desc    List the signed-in buyer's tickets (Bearer buyer token)
 * @access  Buyer
 */
router.get('/my-tickets', authenticateBuyer, PublicController.getMyTickets);

/**
 * Ticket PDF downloads — the "Download" / "Download all" buttons behind
 * My Profile > Tickets. Ownership-checked the same way as /my-tickets
 * (buyerId/phone/email), so a buyer can only download their own tickets.
 * @route   GET  /api/public/tickets/:ticketId/pdf  -> one ticket's PDF (QR + details)
 * @route   POST /api/public/tickets/pdf-bundle      { ticketIds: string[] } -> one PDF, one page per ticket
 * @access  Buyer (Bearer buyer token)
 */
router.get('/tickets/:ticketId/pdf', authenticateBuyer, TicketPdfController.downloadTicketPdf);
router.post('/tickets/pdf-bundle', authenticateBuyer, TicketPdfController.downloadTicketsBundle);

/**
 * Buyer profile (ticket-holder). Identity is the verified phone on the buyer
 * token; only the profile picture is editable here.
 * @route   GET    /api/public/profile           -> { phone, name, avatarUrl }
 * @route   POST   /api/public/profile/avatar     multipart 'avatar' -> { avatarUrl }
 * @route   DELETE /api/public/profile/avatar     -> { avatarUrl: null }
 * @access  Buyer (Bearer buyer token)
 */
router.get('/profile', authenticateBuyer, BuyerProfileController.getProfile);
router.post(
  '/profile/avatar',
  authenticateBuyer,
  avatarUpload.single('avatar'),
  handleMulterError,
  validateFileUpload,
  BuyerProfileController.uploadAvatar,
);
router.delete('/profile/avatar', authenticateBuyer, BuyerProfileController.deleteAvatar);

/**
 * @route   POST /api/public/contact
 * @desc    Submit a message from the public "Contact Support" form. Stored
 *          durably in ContactMessage; best-effort SMS alert to the support
 *          line. No auth — this is the marketing-site contact form.
 * @access  Public
 * @body    name, email, subject, message
 */
router.post('/contact', PublicController.submitContactMessage);

/**
 * @route   POST /api/public/purchase/momo
 * @desc    Initiate an async MTN MoMo ticket purchase. Phone comes from the
 *          buyer token (req.ticketsUser.userPhone), NOT the body.
 *          Returns { referenceId, saleId, expiresAt } — buyer polls the status
 *          endpoint and approves the payment on their phone.
 * @access  Buyer (Bearer buyer token)
 * @body    eventId, ticketTypeId, quantity, customerName?, momoPhone
 */
router.post('/purchase/momo', authenticateBuyer, PublicController.initiateMomoPurchase);

/**
 * @route   GET /api/public/purchase/momo/:referenceId/status
 * @desc    Poll the status of a pending MTN MoMo payment. Also triggers
 *          finalization (ticket minting) when MTN reports SUCCESSFUL.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/momo/:referenceId/status', authenticateBuyer, PublicController.getMomoStatus);

/**
 * @route   POST /api/public/purchase/peach-card
 * @desc    Initiate an async Peach card ticket purchase. Phone comes from the
 *          buyer token (req.ticketsUser.userPhone), NOT the body.
 *          Returns { paymentId, redirect, saleId, expiresAt } — buyer is
 *          redirected to Peach's hosted payment page.
 * @access  Buyer (Bearer buyer token)
 * @body    eventId, ticketTypeId, quantity, customerName?
 */
router.post('/purchase/peach-card', authenticateBuyer, PublicController.initiateCardPurchase);

/**
 * @route   GET /api/public/purchase/peach-card/:paymentId/status
 * @desc    Poll the status of a pending Peach card payment. Also triggers
 *          finalization (ticket minting) when Peach reports success.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/peach-card/:paymentId/status', authenticateBuyer, PublicController.getCardStatus);

/**
 * @route   POST /api/public/purchase/deltapay
 * @desc    Initiate an async DeltaPay hosted-checkout ticket purchase. Phone
 *          comes from the buyer token (req.ticketsUser.userPhone), NOT the body.
 *          Returns { checkoutSessionId, checkoutUrl, saleId, expiresAt } — the
 *          buyer is redirected to DeltaPay's hosted checkout page.
 * @access  Buyer (Bearer buyer token)
 * @body    eventId, ticketTypeId, quantity, customerName?
 */
router.post('/purchase/deltapay', authenticateBuyer, PublicController.initiateDeltapayPurchase);

/**
 * @route   POST /api/public/purchase/yoco
 * @desc    Initiate an async Yoco hosted-checkout ticket purchase. Identity
 *          comes from the authenticated buyer, never the body. Returns the
 *          Yoco redirect URL for the SPA to send the buyer to.
 * @access  Buyer (authenticated)
 */
router.post('/purchase/yoco', authenticateBuyer, PublicController.initiateYocoPurchase);

/**
 * @route   POST /api/public/purchase/yebopay
 * @desc    Initiate an async YeboPay hosted-checkout ticket purchase. Identity
 *          comes from the authenticated buyer, never the body. Returns the
 *          YeboPay hosted URL for the SPA to send the buyer to.
 * @access  Buyer (authenticated)
 */
router.post('/purchase/yebopay', authenticateBuyer, PublicController.initiateYeboPayPurchase);

/**
 * @route   GET /api/public/purchase/yebopay/by-ref/:ref/status
 * @desc    Outcome of ONE YeboPay payment by reference, scoped to the caller's
 *          own sales. Exact where /latest/status is a heuristic.
 * @access  Buyer (authenticated)
 */
router.get('/purchase/yebopay/by-ref/:ref/status', authenticateBuyer, PublicController.getYeboPayStatusByRef);

/**
 * @route   GET /api/public/purchase/yebopay/latest/status
 * @desc    Outcome of the buyer's most recent YeboPay payment. The YeboPay
 *          return redirect carries no identifiers by design, so the result page
 *          asks this authenticated endpoint rather than parsing the URL.
 * @access  Buyer (authenticated)
 */
router.get('/purchase/yebopay/latest/status', authenticateBuyer, PublicController.getLatestYeboPayStatus);

/**
 * @route   GET /api/public/purchase/yoco/latest/status
 * @desc    Outcome of the buyer's most recent Yoco payment, with no identifier
 *          on the URL. Declared BEFORE the /:checkoutId/status route so that
 *          "latest" is not captured as a checkout id.
 * @access  Buyer (authenticated)
 */
router.get('/purchase/yoco/latest/status', authenticateBuyer, PublicController.getLatestYocoStatus);

/**
 * @route   GET /api/public/purchase/yoco/:checkoutId/status
 * @desc    Read the status of a Yoco purchase. READ-ONLY — unlike the card and
 *          DeltaPay pollers this does NOT finalise, because Yoco exposes no
 *          status-query endpoint; only the signed webhook can mint.
 * @access  Buyer (authenticated, must own the sale)
 */
router.get('/purchase/yoco/:checkoutId/status', authenticateBuyer, PublicController.getYocoStatus);

/**
 * @route   GET /api/public/purchase/deltapay/latest/status
 * @desc    Outcome of the buyer's MOST RECENT DeltaPay payment. The reliable way
 *          to answer "did it go through?" after a DeltaPay return, because the
 *          return redirect carries no identifiers we can depend on. Also
 *          finalises (mints) as a side effect. Returns { status: 'none' } if the
 *          buyer has never paid with DeltaPay.
 *          MUST stay ABOVE the /:sessionId/status route below — otherwise
 *          "latest" is captured as a sessionId and never reaches this handler.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/deltapay/latest/status', authenticateBuyer, PublicController.getLatestDeltapayStatus);

/**
 * @route   GET /api/public/purchase/deltapay/:sessionId/status
 * @desc    Poll the status of a pending DeltaPay payment. Also triggers
 *          finalization (ticket minting) when DeltaPay reports `succeeded`.
 * @access  Buyer (Bearer buyer token)
 */
router.get('/purchase/deltapay/:sessionId/status', authenticateBuyer, PublicController.getDeltapayStatus);

export default router;
