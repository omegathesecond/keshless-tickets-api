import { Router } from 'express';
import { TicketsController } from '@controllers/tickets.controller';
import { TicketPdfController } from '@controllers/ticketPdf.controller';
import {
  authenticateTickets,
  requireTicketsPermission,
  requireAnyPermission,
  requireSuperAdmin,
  requireSuperAdminOrPermission,
} from '@middleware/ticketsAuth.middleware';
import { dualAuth } from '@middleware/serviceAuth.middleware';
import { avatarUpload, handleMulterError, validateFileUpload } from '@middleware/media.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { SettingsController } from '@controllers/settings.controller';
import { GateOperatorAdminController } from '@controllers/gateOperatorAdmin.controller';
import { CashierAdminController } from '@controllers/cashierAdmin.controller';
import { WaiterAdminController } from '@controllers/waiterAdmin.controller';
import { MerchantAdminController } from '@controllers/merchantAdmin.controller';
import { MerchantOperatorAdminController } from '@controllers/merchantOperatorAdmin.controller';
import { OrganizerCashlessController } from '@controllers/organizerCashless.controller';
import { CashlessReconciliationController } from '@controllers/cashlessReconciliation.controller';
import { StockAdminController } from '@controllers/stockAdmin.controller';
import { MenuAdminController } from '@controllers/menuAdmin.controller';
import { StockReportController } from '@controllers/stockReport.controller';
import { TableReportController } from '@controllers/tableReport.controller';
import { EventTagController } from '@controllers/eventTag.controller';
import { TagReportController } from '@controllers/tagReport.controller';
import { TagAdminController } from '@controllers/tagAdmin.controller';
import { AdminUsersController } from '@controllers/adminUsers.controller';
import { AdminOrganizersController } from '@controllers/adminOrganizers.controller';
import { AdminServiceCategoriesController } from '@controllers/adminServiceCategories.controller';
import { AdminFeesController } from '@controllers/adminFees.controller';
import { WristbandController } from '@controllers/wristband.controller';
import { OrganizerProfileController } from '@controllers/organizerProfile.controller';
import { ReviewController } from '@controllers/review.controller';
import { AnnouncementController } from '@controllers/announcement.controller';
import { ChannelAdminController } from '@controllers/channelAdmin.controller';
import { ModerationController } from '@controllers/moderation.controller';
import { ReportController } from '@controllers/report.controller';
import { EnquiryController } from '@controllers/enquiry.controller';
import { UpdateController } from '@controllers/update.controller';
import { VoteAdminController } from '@controllers/voteAdmin.controller';

const router = Router();

/**
 * Authentication Routes
 * Public routes - no authentication required
 */
router.post('/auth/login', TicketsController.login);
// Self-service organizer signup (public): request a code, then verify + create.
router.post('/auth/register/request-otp', TicketsController.requestRegistrationOtp);
router.post('/auth/register', TicketsController.register);
// Self-service SERVICES business signup (public): reuses the same request-otp step.
router.post('/auth/business/register', TicketsController.registerBusiness);
// Self-service organizer password reset (public): request a code, then verify + set.
router.post('/auth/forgot-password', TicketsController.forgotPassword);
router.post('/auth/reset-password', TicketsController.resetPassword);
router.post('/auth/refresh', TicketsController.refresh);
// Social SSO handoff: mint (dashboard, authed) → exchange (social site, public).
router.post('/auth/handoff', authenticateTickets, TicketsController.socialHandoff);
router.post('/auth/handoff/exchange', TicketsController.socialHandoffExchange);

/**
 * Authenticated Routes
 * All routes below require authentication via either:
 * - JWT token (Authorization header) for dashboard access
 * - Service key (x-service-key header) for proxied app requests from main Keshless API
 */
router.use(dualAuth);

/**
 * Admin-only settings routes (super admin only)
 */
router.get('/settings/payment-methods', requireSuperAdmin, SettingsController.getPaymentMethods);
router.put('/settings/payment-methods', requireSuperAdmin, SettingsController.updatePaymentMethods);

/**
 * Platform Users admin — registered-buyer directory + signup analytics.
 * Carrot super-admins or team members holding tickets:view_users. Buyers are
 * platform-wide, so this is intentionally NOT vendor-scoped.
 */
router.get(
  '/admin/users',
  requireSuperAdminOrPermission(TicketsPermission.VIEW_USERS),
  AdminUsersController.listUsers,
);
router.get(
  '/admin/users/analytics',
  requireSuperAdminOrPermission(TicketsPermission.VIEW_USERS),
  AdminUsersController.analytics,
);

/**
 * Organizers admin — vendor directory + verification lifecycle behind the
 * dashboard "Organizers" tab. Super-admin only.
 */
router.get('/admin/organizers', requireSuperAdmin, AdminOrganizersController.listOrganizers);
router.post('/admin/organizers', requireSuperAdmin, AdminOrganizersController.createOrganizer);
router.patch('/admin/organizers/:id/verification', requireSuperAdmin, AdminOrganizersController.updateVerification);

/**
 * Service-categories admin — the DB-driven category manager behind the
 * dashboard's "Service Categories" panel. Super-admin only, mirroring
 * /admin/organizers. Backs GET /api/public/service-categories and
 * ServiceCategoryService.isValidActive (checked at SERVICES signup).
 */
router.get('/admin/service-categories', requireSuperAdmin, AdminServiceCategoriesController.list);
router.post('/admin/service-categories', requireSuperAdmin, AdminServiceCategoriesController.create);
router.patch('/admin/service-categories/:id', requireSuperAdmin, AdminServiceCategoriesController.update);

// Fees — per-event booking charges Carrot has collected (super-admin only)
router.get('/admin/fees', requireSuperAdmin, AdminFeesController.getFees);

/**
 * Wristband printing — platform staff only (Carrot office printer + Tyvek
 * stock). Super-admins or team members holding tickets:print_wristbands.
 * Intentionally NOT vendor-scoped, mirroring /admin/users.
 */
router.get('/wristband-designs', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.listDesigns);
router.post('/wristband-designs', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.createDesign);
router.put('/wristband-designs/:id', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.updateDesign);
router.delete('/wristband-designs/:id', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.deleteDesign);

/**
 * Wristband batch issuance — zero-amount, real, scannable tickets minted
 * from the office printer run. Same platform-staff-only gate as above.
 */
router.post('/wristbands/batch-issue', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.batchIssue);
router.get('/wristbands/batches', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.listBatches);
router.get('/wristbands/tickets', requireSuperAdminOrPermission(TicketsPermission.PRINT_WRISTBANDS), WristbandController.searchTickets);

/**
 * Social moderation queue — buyer-filed reports against messages/buyers.
 * Super-admins or team members holding tickets:moderate_social. Intentionally
 * NOT vendor-scoped, mirroring /admin/users and the wristband routes above.
 */
router.get('/reports', requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL), ReportController.list);
router.post(
  '/reports/:reportId/resolve',
  requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL),
  ReportController.resolve
);

/**
 * Discover moderation — platform staff hide/un-hide a post from the public
 * Discover ('for-you') feed WITHOUT taking it down: it stays on the author's
 * profile and in followers' feeds (the filter is scoped to 'for-you' in
 * feed.service). Same MODERATE_SOCIAL gate as the report queue above.
 */
router.post(
  '/updates/:id/hide-from-discover',
  requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL),
  UpdateController.hideFromDiscover
);
router.delete(
  '/updates/:id/hide-from-discover',
  requireSuperAdminOrPermission(TicketsPermission.MODERATE_SOCIAL),
  UpdateController.unhideFromDiscover
);

// Auth management
router.post('/auth/logout', TicketsController.logout);
router.get('/auth/me', TicketsController.getMe);

/**
 * End-customer ticket list — the Keshless user-app calls this to show
 * a logged-in user every ticket bought with their phone number.
 * Mounted before the vendor-scoped /events block so the path resolves
 * cleanly. Auth is the existing dualAuth: when the main keshless-api
 * proxy forwards a Keshless user JWT, serviceAuth attaches userPhone
 * to req.ticketsUser; when called directly with a vendor JWT, the
 * lookup will see no phone and 401.
 */
router.get('/my-tickets', TicketsController.getMyTickets);

/**
 * In-app ticket purchase for a logged-in Keshless user (card + PIN payment).
 * Driven by the main keshless-api proxy with the shared service key; the buyer
 * phone comes from the forwarded x-user-phone. Same flow + cost as the web
 * buyer checkout (/api/public/purchase) — both call purchaseForCustomer.
 */
router.post('/purchase', TicketsController.purchaseAsUser);

/**
 * Vendor ticket-PDF bytes download — the dashboard's per-ticket "Download"
 * action, assembled client-side into a ZIP. Bytes (not the shareable R2 URL
 * below) because cross-origin R2 fetches depend on bucket CORS. Vendor-scoped
 * via TicketService.resolveVendorTicket (own ticket or super-admin), same
 * ownership check as PATCH /:ticketId/recipient above. Registered before
 * /:ticketId/pdf for consistency, though the two- and three-segment patterns
 * cannot shadow each other.
 */
router.get(
  '/:ticketId/pdf/download',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketPdfController.downloadVendorTicketPdf
);

/**
 * Shareable ticket PDF — lazily generated and cached in R2.
 * Accepts the ticket code (TKT-…) or Mongo _id. Authorised either by the
 * requester's phone matching the ticket (user-app via proxy) or by vendor
 * ownership / super-admin (dashboard). The `/pdf` suffix keeps this clear of
 * the vendor-scoped `/events/:eventId` and other routes above.
 */
router.get('/:ticketId/pdf', TicketPdfController.getTicketPdf);

/**
 * User Account Settings Routes
 */
router.put('/users/profile', TicketsController.updateProfile);
router.put('/users/password', TicketsController.changePassword);

/**
 * Organizer own-profile — vendor sets its own public brand card (logo + bio)
 * consumed by the public organizer profile and organizer-branded chat.
 */
router.patch(
  '/organizer/profile',
  requireTicketsPermission(TicketsPermission.EDIT_BRAND),
  OrganizerProfileController.updateOwn
);

/**
 * Organizer brand logo upload — multipart 'logo' -> { logoUrl }. Mirrors
 * BuyerProfileController.uploadAvatar (same avatarUpload multer config + R2
 * key/upload/delete-previous idiom), gated by the same permission as the
 * profile PATCH above.
 */
router.post(
  '/organizer/profile/logo',
  requireTicketsPermission(TicketsPermission.EDIT_BRAND),
  avatarUpload.single('logo'),
  handleMulterError,
  validateFileUpload,
  OrganizerProfileController.uploadLogo,
);

/**
 * Event Management Routes
 */
router.get(
  '/events',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEvents
);

router.get(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEvent
);

router.get(
  '/events/:eventId/creator',
  requireTicketsPermission(TicketsPermission.VIEW_EVENTS),
  TicketsController.getEventCreator
);

router.post(
  '/events',
  requireTicketsPermission(TicketsPermission.CREATE_EVENT),
  TicketsController.createEvent
);

router.put(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.updateEvent
);

// An organizer cannot flip `cashless` themselves (EventService.updateEvent
// gates it to admins) — this is how they ask for it.
router.post(
  '/events/:eventId/cashless-request',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.requestCashless
);

router.delete(
  '/events/:eventId',
  requireTicketsPermission(TicketsPermission.DELETE_EVENT),
  TicketsController.deleteEvent
);

router.put(
  '/events/:eventId/publish',
  requireTicketsPermission(TicketsPermission.PUBLISH_EVENT),
  TicketsController.publishEvent
);

router.put(
  '/events/:eventId/unpublish',
  requireTicketsPermission(TicketsPermission.PUBLISH_EVENT),
  TicketsController.unpublishEvent
);

/**
 * Organizer announcements — post into the event's #announcements channel.
 * dualAuth (router-level) already authenticated the request; this route only
 * needs the permission gate. Ownership (own events only) is checked in the
 * controller, matching the reviews reply pattern below.
 */
router.post(
  '/events/:eventId/announcements',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  AnnouncementController.post
);

/**
 * Organizer channel management — list/create/patch the text channels inside
 * an event's community. Same auth shape as announcements: dualAuth
 * (router-level) authenticates, the permission gate is here, and ownership
 * (own events only) is checked in the controller.
 */
router.get(
  '/events/:eventId/channels',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.list
);

router.post(
  '/events/:eventId/channels',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.create
);

router.patch(
  '/channels/:channelId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ChannelAdminController.update
);

/**
 * Organizer moderation — delete-any-message, mute/ban members, pinned
 * messages, and the admin member roster. Same auth shape as channel
 * management: dualAuth (router-level) authenticates, the permission gate is
 * here, and ownership (own events only, community -> event -> vendorId) is
 * checked in the controller.
 */
router.delete(
  '/messages/:messageId',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.deleteMessage
);

router.post(
  '/messages/:messageId/pin',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.pin
);

router.delete(
  '/messages/:messageId/pin',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unpin
);

router.get(
  '/communities/:communityId/members',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.listMembers
);

router.post(
  '/communities/:communityId/members/:buyerId/mute',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.mute
);

router.delete(
  '/communities/:communityId/members/:buyerId/mute',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unmute
);

router.post(
  '/communities/:communityId/members/:buyerId/ban',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.ban
);

router.delete(
  '/communities/:communityId/members/:buyerId/ban',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ModerationController.unban
);

/**
 * Ticket Type Management Routes
 */
router.post(
  '/events/:eventId/tickets',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.addTicketType
);

router.put(
  '/events/:eventId/tickets/:ticketTypeName',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.updateTicketType
);

router.delete(
  '/events/:eventId/tickets/:ticketTypeName',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.deleteTicketType
);

router.patch(
  '/events/:eventId/tickets/:ticketTypeName/adjust',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.adjustTicketQuantity
);

router.patch(
  '/events/:eventId/tickets/:ticketTypeName/sold-out',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  TicketsController.markTicketSoldOut
);

/**
 * Review Management Routes — vendor reply to a buyer's post-event review.
 * dualAuth (router-level) already authenticated the request; this route only
 * needs the permission gate.
 */
router.post(
  '/reviews/:reviewId/reply',
  requireTicketsPermission(TicketsPermission.EDIT_EVENT),
  ReviewController.reply
);

/**
 * Ticket Sales Routes
 */
router.post(
  '/sales/sell',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.sellTickets
);

router.post(
  '/sales/:saleId/send-sms',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.sendSaleSms
);

router.patch(
  '/:ticketId/recipient',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.updateTicketRecipient
);

router.get(
  '/sales',
  requireTicketsPermission(TicketsPermission.VIEW_SALES),
  TicketsController.getSales
);

router.get(
  '/sales/:saleId',
  requireTicketsPermission(TicketsPermission.VIEW_SALES),
  TicketsController.getSale
);

router.post(
  '/sales/:ticketId/refund',
  requireTicketsPermission(TicketsPermission.REFUND_TICKET),
  TicketsController.refundTicket
);

/**
 * Entry Scanning Routes
 */
router.post(
  '/scans/validate',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.validateTicket
);

router.post(
  '/scans/check-in',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.checkInTicket
);

router.post(
  '/scans/bind-band',
  requireTicketsPermission(TicketsPermission.ISSUE_TAGS),
  TicketsController.bindBand
);

router.post(
  '/scans/reissue-band',
  requireTicketsPermission(TicketsPermission.ISSUE_TAGS),
  TicketsController.reissueBand
);

/**
 * Gate-side cashless wallet lookup (cashless spec §5.1/§5.3) — tap a band, see
 * its wallet balance + recent history. Same SCAN_TICKETS gate as the rest of
 * the gate flow above.
 */
router.get(
  '/wallets/by-band/:uid',
  requireTicketsPermission(TicketsPermission.SCAN_TICKETS),
  TicketsController.walletByBand
);

router.get(
  '/scans/stats',
  requireTicketsPermission(TicketsPermission.VIEW_SCANS),
  TicketsController.getScanStats
);

router.get(
  '/scans',
  requireTicketsPermission(TicketsPermission.VIEW_SCANS),
  TicketsController.getScans
);

/**
 * Analytics & Statistics Routes
 */
router.get(
  '/stats/dashboard',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getDashboardStats
);

router.get(
  '/stats/sales',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getSalesStats
);

router.get(
  '/stats/revenue',
  requireTicketsPermission(TicketsPermission.VIEW_REVENUE),
  TicketsController.getRevenueStats
);

router.get(
  '/stats/events/:eventId',
  requireTicketsPermission(TicketsPermission.VIEW_STATS),
  TicketsController.getEventAnalytics
);

// Money breakdown for one event — VIEW_REVENUE, not VIEW_STATS: this returns
// proceeds and custody, which VIEW_STATS holders are not entitled to see.
router.get(
  '/stats/events/:eventId/financials',
  requireTicketsPermission(TicketsPermission.VIEW_REVENUE),
  TicketsController.getEventFinancials
);

/**
 * Export Routes
 */
router.get(
  '/export/sales',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportSales
);

router.get(
  '/export/revenue',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportRevenue
);

router.get(
  '/export/events/:eventId/summary',
  requireTicketsPermission(TicketsPermission.EXPORT_REPORTS),
  TicketsController.exportEventSummary
);

/**
 * Gate Operator Admin Routes
 */
router.get('/gate-operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.list);
router.post('/gate-operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.create);
router.patch('/gate-operators/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.update);
router.get('/gate-operators/:id/activity', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.activity);
router.post('/gate-operators/:id/reset-pin', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), GateOperatorAdminController.resetPin);

/**
 * Services business enquiry inbox — leads submitted via
 * POST /api/public/services/:businessId/enquiries.
 */
router.get('/services/enquiries', requireTicketsPermission(TicketsPermission.MANAGE_ENQUIRIES), EnquiryController.list);
router.patch('/services/enquiries/:id/status', requireTicketsPermission(TicketsPermission.MANAGE_ENQUIRIES), EnquiryController.setStatus);

/**
 * Cashier Admin Routes — an organizer creates/deactivates the in-venue money
 * desk staff who top up + cash out attendee wallets. Same MANAGE_ACCESS gate +
 * organizer-scoping as gate operators; a cashier is NOT a reseller.
 */
router.get('/cashiers', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), CashierAdminController.list);
router.post('/cashiers', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), CashierAdminController.create);
router.get('/cashiers/:id/transactions', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), CashierAdminController.transactions);
router.patch('/cashiers/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), CashierAdminController.update);
router.post('/cashiers/:id/reset-pin', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), CashierAdminController.resetPin);

/**
 * Waiter Admin Routes — an organizer hires/disables the floor staff who open
 * tables, add items from several stalls, and settle against an NFC tag.
 * requireSuperAdminOrPermission (not the bare requireTicketsPermission used by
 * the cashier/gate-operator routes above): a super-admin token carries an
 * EMPTY permissions array, and gating staff admin on the bare check is the
 * defect fixed in 5b4820c for the tag registry routes.
 */
router.post('/waiters', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.create);
router.get('/waiters', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.list);
router.patch('/waiters/:id', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.update);
router.post('/waiters/:id/reset-pin', requireSuperAdminOrPermission(TicketsPermission.MANAGE_ACCESS), WaiterAdminController.resetPin);

/**
 * Vendor (in-event merchant) Admin Routes — an organizer sets up the stalls
 * that charge bands at their cashless event, each with a commission cut. A
 * merchant is scoped to ONE event; ownership of that event is enforced in the
 * controller. Same MANAGE_ACCESS gate as gate operators + cashiers.
 */
// GET is also reachable with MANAGE_STOCK alone: the Catalogue tab's "Sold
// at" stall picker needs this list to allocate products to stalls, and a
// MANAGER-role organizer holds MANAGE_STOCK without MANAGE_ACCESS (see
// TICKETS_ROLE_PERMISSIONS) — mirroring the tab's own gate is a read, not
// access management. Create/edit/operators below stay MANAGE_ACCESS-only.
router.get('/merchants', requireAnyPermission([TicketsPermission.MANAGE_ACCESS, TicketsPermission.MANAGE_STOCK]), MerchantAdminController.list);
router.post('/merchants', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantAdminController.create);
router.get('/merchants/:id/transactions', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantAdminController.transactions);
router.patch('/merchants/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantAdminController.update);

/**
 * The people on a stall's till. Same MANAGE_ACCESS gate as the stall itself.
 */
router.get('/merchants/:merchantId/operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.list);
router.post('/merchants/:merchantId/operators', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.create);
router.patch('/merchant-operators/:id', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.update);
router.post('/merchant-operators/:id/reset-pin', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), MerchantOperatorAdminController.resetPin);

/**
 * Organizer Cashless Reporting — the "you're in charge" view of one event:
 * circulated / spent / withdrawn / left-behind, per-vendor takings, per-cashier
 * activity, and the full transaction log. Money data → VIEW_REVENUE; ownership
 * (own event only) is enforced in the controller.
 */
router.get('/events/:eventId/cashless/summary', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), OrganizerCashlessController.summary);
router.get('/events/:eventId/cashless/transactions', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), OrganizerCashlessController.transactions);
// Super-admin only: the three internal ledger checks (accounting identity,
// journal integrity, stored wallet balance vs journal) for one cashless event.
// Read-only — it reports drift, never repairs it. The same checks run on a
// timer over recently-ended cashless events (see tasks/backgroundTasks.ts).
router.get('/events/:eventId/cashless/reconciliation', requireSuperAdmin, CashlessReconciliationController.get);

/**
 * Cashless Stock Reporting (design 2026-08-13, Slice 4) — organiser read-only
 * views over the stock journal: live board, reconciliation, event dashboard,
 * movements audit. Stock figures are revenue-adjacent → VIEW_REVENUE; ownership
 * (own cashless event only) enforced by the shared guard in the controller.
 */
/**
 * Tag management — the wallets behind the NFC tags at a cashless event.
 * ORDER MATTERS: the literal /tags/summary must stay above /tags/:walletId,
 * or Express matches "summary" as a wallet id.
 */
/**
 * Vote (organizer dashboard §9) — preview before activation, genuine
 * participation stats + results + song suggestions once open, and
 * discussion moderation. Ownership (or super-admin) is enforced inside
 * vote.service/voteDiscussion.service, same pattern as
 * ModerationController's community routes below.
 */
router.get('/events/:eventId/vote/preview', requireTicketsPermission(TicketsPermission.VIEW_STATS), VoteAdminController.preview);
router.get('/events/:eventId/vote/summary', requireTicketsPermission(TicketsPermission.VIEW_STATS), VoteAdminController.summary);
router.get('/vote-questions/:questionId/comments', requireTicketsPermission(TicketsPermission.VIEW_STATS), VoteAdminController.comments);
router.delete('/vote-comments/:commentId', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), VoteAdminController.removeComment);

router.get('/events/:eventId/tags/summary', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.summary);
router.get('/events/:eventId/tags/registrations', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.registrations);

/**
 * The event's TAG REGISTER — which physical tags the organizer has enrolled
 * into this show. Distinct from /tags above: those are the WALLETS behind tags
 * already handed to attendees; this is the pool of plastic that is allowed to
 * become one at all. Gated on ISSUE_TAGS so the Register desk reaches it as
 * well as the organizer — it is the desk's own screen.
 *
 * Carrot staff pass on the isSuperAdmin claim instead of the permission: a
 * super-admin token carries an EMPTY permissions array (platform staff are not
 * given every organizer's grants), so a bare requireTicketsPermission refused
 * the very people who supply the tags. The controller below was already
 * written for them — loadOwnedCashlessEvent lets platform staff onto another
 * vendor's event — so the gate, not the controller, was the odd one out.
 *
 * ORDER MATTERS: /tags/registry must stay above /tags/:walletId, or Express
 * matches "registry" as a wallet id.
 */
router.get('/events/:eventId/tags/registry', requireSuperAdminOrPermission(TicketsPermission.ISSUE_TAGS), EventTagController.list);
router.post('/events/:eventId/tags/registry', requireSuperAdminOrPermission(TicketsPermission.ISSUE_TAGS), EventTagController.register);
router.post('/events/:eventId/tags/registry/retire', requireSuperAdminOrPermission(TicketsPermission.ISSUE_TAGS), EventTagController.retire);
// Hand a registered tag to somebody with no ticket: gives it a wallet of its
// own so the cashier desk can load it (design 2026-09-05). Same gate and same
// ownership guard as the register routes above — issuing is the desk's job.
router.post('/events/:eventId/tags/issue', requireSuperAdminOrPermission(TicketsPermission.ISSUE_TAGS), EventTagController.issue);
router.get('/events/:eventId/tags', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.list);
router.get('/events/:eventId/tags/:walletId', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), TagReportController.detail);
router.post('/events/:eventId/tags/:walletId/deactivate', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), TagAdminController.deactivate);
router.post('/events/:eventId/tags/:walletId/reissue', requireTicketsPermission(TicketsPermission.MANAGE_ACCESS), TagAdminController.reissue);
router.post('/events/:eventId/tags/:walletId/refund', requireTicketsPermission(TicketsPermission.REFUND_TICKET), TagAdminController.refund);

router.get('/events/:eventId/stock/board', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.board);
router.get('/events/:eventId/stock/reconciliation', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.reconciliation);
router.get('/events/:eventId/stock/dashboard', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.dashboard);
router.get('/events/:eventId/stock/movements', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.movements);

/**
 * The organizer's Tables view (task 13) — a waiter opens a table, adds items
 * from several stalls, and settles against an NFC tag; this is the read-only
 * rollup: what is still open, what was settled, and what walked out unpaid.
 * requireSuperAdminOrPermission, NOT the bare requireTicketsPermission above:
 * a super-admin token carries an EMPTY permissions array, and gating a
 * revenue view on the bare check is the defect fixed in 5b4820c. Ownership
 * (own cashless event only, platform staff exempted) is enforced in the
 * controller via the shared loadOwnedCashlessEvent guard.
 */
router.get('/events/:eventId/tables', requireSuperAdminOrPermission(TicketsPermission.VIEW_REVENUE), TableReportController.list);

/**
 * Cashless Stock/Inventory — organiser manages the product catalogue and
 * loads per-bar stock (design 2026-08-12, Slice 1). MANAGE_STOCK gate +
 * event-ownership enforced in the controller.
 */
router.post('/events/:eventId/products', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.createProduct);
router.get('/events/:eventId/products', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.listProducts);
router.patch('/products/:id', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.updateProduct);
router.post('/events/:eventId/stock/receive', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.receiveStock);
router.patch('/events/:eventId/stock/threshold', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.setThreshold);
router.post('/events/:eventId/stock/transfer', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.transferStock);
router.post('/events/:eventId/stock/count', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.recordCount);
router.get('/events/:eventId/stock/allocations', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.listAllocations);
router.put('/events/:eventId/stock/allocations', requireTicketsPermission(TicketsPermission.MANAGE_STOCK), StockAdminController.setAllocations);

/**
 * Event Menu — organiser manages the bar/vendor preorder catalogue shown on
 * the public event page's "Menu" tab, and reviews incoming preorders.
 * MANAGE_MENU gate + event-ownership enforced in the controller.
 */
router.post('/events/:eventId/menu-items', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.createItem);
router.get('/events/:eventId/menu-items', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.listItems);
router.patch('/menu-items/:id', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.updateItem);
router.delete('/menu-items/:id', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.deleteItem);
router.get('/events/:eventId/menu-orders', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.listOrders);
router.patch('/menu-orders/:id', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.updateOrderFulfillment);
// QR-based collection scanner: looks up/confirms by the human-readable orderId
// (not the Mongo _id) that the buyer's QR code encodes.
router.post('/menu-orders/scan', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.lookupOrderByCode);
router.post('/menu-orders/collect', requireTicketsPermission(TicketsPermission.MANAGE_MENU), MenuAdminController.collectOrder);

export default router;
