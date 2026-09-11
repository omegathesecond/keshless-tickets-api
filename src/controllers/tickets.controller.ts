import { Request, Response } from 'express';
import Joi from 'joi';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { EventService } from '@services/event.service';
import { TicketService } from '@services/ticket.service';
import { ScanService } from '@services/scan.service';
import { AnalyticsService } from '@services/analytics.service';
import { EventFinancialsService } from '@services/eventFinancials.service';
import { ExportService } from '@services/export.service';
import { WalletService } from '@services/wallet.service';
import { normalizeBandUid } from '@utils/bandUid.util';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import {
  loginSchema,
  registerSchema,
  businessRegisterSchema,
  requestRegistrationOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  changePasswordSchema,
  createEventSchema,
  updateEventSchema,
  cashlessRequestSchema,
  eventQuerySchema,
  sellTicketSchema,
  refundTicketSchema,
  ticketSalesQuerySchema,
  ticketSalesExportQuerySchema,
  validateTicketSchema,
  checkInTicketSchema,
  bindBandSchema,
  reissueBandSchema,
  scanQuerySchema,
  analyticsQuerySchema
} from '@validators/tickets.validator';
import { MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
import { resolveOperatorEventScope, operatorMayActOnEvent } from '@services/operatorEventScope.service';

export class TicketsController {
  /**
   * Authentication: Login
   */
  static async login(req: Request, res: Response): Promise<any> {
    try {
      // Validate input
      const { error, value } = loginSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const { identifier, password } = value;

      // Login
      const result = await TicketsAuthService.login(identifier, password);

      ApiResponseUtil.success(res, result, 'Login successful');
    } catch (error: any) {
      console.error('Login error:', error);
      ApiResponseUtil.error(res, error.message || 'Login failed', 401);
    }
  }

  /**
   * POST /api/tickets/auth/handoff — mint a one-time social sign-in link from
   * the (already-authenticated) dashboard session. Requires authenticateTickets.
   */
  static async socialHandoff(req: Request, res: Response): Promise<any> {
    try {
      const handoff = TicketsAuthService.mintSocialHandoff((req as any).ticketsUser);
      return ApiResponseUtil.success(res, { handoff }, 'Handoff created');
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Failed to create handoff', 401);
    }
  }

  /**
   * POST /api/tickets/auth/handoff/exchange { handoff } — the social site
   * exchanges a one-time handoff for a normal vendor access token. No auth.
   */
  static async socialHandoffExchange(req: Request, res: Response): Promise<any> {
    try {
      const handoff = req.body?.handoff;
      if (!handoff || typeof handoff !== 'string') {
        return ApiResponseUtil.error(res, 'handoff is required', 400);
      }
      const result = await TicketsAuthService.exchangeSocialHandoff(handoff);
      return ApiResponseUtil.success(res, result, 'Signed in');
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Failed to sign in', 401);
    }
  }

  /**
   * Authentication: Step 1 of self-service organizer signup — request a code.
   * POST /api/tickets/auth/register/request-otp { email?, phoneNumber? }
   */
  static async requestRegistrationOtp(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = requestRegistrationOtpSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketsAuthService.requestRegistrationOtp(value);

      // Echo the channel + identifier so the dashboard can tell the organizer
      // where the code went ("We texted your phone" / "Check your email").
      ApiResponseUtil.success(res, result, 'Verification code sent.');
    } catch (error: any) {
      console.error('Registration OTP error:', error);
      ApiResponseUtil.error(res, error.message || 'Could not send verification code', 400);
    }
  }

  /**
   * Authentication: Step 2 of self-service organizer signup — verify + create.
   * On success the organizer is signed straight in (same shape as login).
   * POST /api/tickets/auth/register { businessName, email?, phoneNumber?, password, code }
   */
  static async register(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = registerSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketsAuthService.register(value);

      ApiResponseUtil.created(res, result, 'Account created. You can start building events now — publishing unlocks once your account is verified.');
    } catch (error: any) {
      console.error('Register error:', error);
      ApiResponseUtil.error(res, error.message || 'Registration failed', 400);
    }
  }

  /**
   * POST /api/tickets/auth/business/register — create an event SERVICE business
   * (operatorType 'services'): sells no tickets, appears in the Services
   * directory once verified. OTP-gated (reuses /auth/register/request-otp).
   */
  static async registerBusiness(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = businessRegisterSchema.validate(req.body);
      if (error) { ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400); return; }
      const result = await TicketsAuthService.registerBusiness(value);
      ApiResponseUtil.created(res, result, 'Business account created. Your profile goes live once verified.');
    } catch (error: any) {
      console.error('Business register error:', error);
      ApiResponseUtil.error(res, error.message || 'Registration failed', 400);
    }
  }

  /**
   * Authentication: Step 1 of organizer password reset — request a code.
   * POST /api/tickets/auth/forgot-password { identifier }
   */
  static async forgotPassword(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = forgotPasswordSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketsAuthService.requestPasswordResetOtp(value.identifier);

      // Echo the channel + identifier so the dashboard can tell the organizer
      // where the code went ("We texted your phone" / "Check your email").
      ApiResponseUtil.success(res, result, 'If that account exists, a reset code is on its way.');
    } catch (error: any) {
      console.error('Forgot password error:', error);
      ApiResponseUtil.error(res, error.message || 'Could not send reset code', 400);
    }
  }

  /**
   * Authentication: Step 2 of organizer password reset — verify + set password.
   * On success the organizer is signed straight in (same shape as login).
   * POST /api/tickets/auth/reset-password { identifier, code, newPassword }
   */
  static async resetPassword(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = resetPasswordSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketsAuthService.resetPassword(value.identifier, value.code, value.newPassword);

      ApiResponseUtil.success(res, result, 'Password updated. You are signed in.');
    } catch (error: any) {
      console.error('Reset password error:', error);
      ApiResponseUtil.error(res, error.message || 'Could not reset password', 400);
    }
  }

  /**
   * Authentication: Refresh token
   */
  static async refresh(req: Request, res: Response): Promise<any> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        ApiResponseUtil.error(res, 'Refresh token is required', 400);
        return;
      }

      const result = await TicketsAuthService.refreshAccessToken(refreshToken);

      ApiResponseUtil.success(res, result, 'Token refreshed successfully');
    } catch (error: any) {
      console.error('Refresh token error:', error);
      ApiResponseUtil.error(res, error.message || 'Token refresh failed', 401);
    }
  }

  /**
   * Authentication: Logout
   */
  static async logout(req: Request, res: Response): Promise<any> {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        await TicketsAuthService.revokeRefreshToken(refreshToken);
      }

      ApiResponseUtil.success(res, null, 'Logged out successfully');
    } catch (error: any) {
      console.error('Logout error:', error);
      ApiResponseUtil.error(res, error.message || 'Logout failed');
    }
  }

  /**
   * Authentication: Get current user
   */
  static async getMe(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      const user = await TicketsAuthService.getMe(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string
      );

      ApiResponseUtil.success(res, user);
    } catch (error: any) {
      console.error('Get me error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch user');
    }
  }

  /**
   * User: List the authenticated Keshless user's purchased tickets.
   * Matches on the user's phone number (which the main keshless-api
   * proxy forwards as `x-user-phone` and the serviceAuth middleware
   * attaches as `req.ticketsUser.userPhone`). Falls back to the raw
   * header for direct-call scenarios (curl tests, future SDKs).
   */
  static async getMyTickets(req: Request, res: Response): Promise<any> {
    try {
      // Trust ONLY the phone the service-auth middleware attached from the
      // validated proxy request. Never read the raw x-user-phone header here —
      // that would let any holder of the service key scope the lookup to an
      // arbitrary number (spoofable-field auth bypass).
      const ticketsUser = (req as any).ticketsUser;
      const phone = ticketsUser?.userPhone as string | undefined;

      if (!phone) {
        ApiResponseUtil.unauthorized(res, 'Authenticated user phone required');
        return;
      }

      const tickets = await TicketService.findTicketsByCustomerPhone(phone);
      console.log(`[my-tickets] phone=${phone.replace(/(\+\d{3})\d+(\d{4})/, '$1***$2')} found=${tickets.length}`);
      ApiResponseUtil.success(res, tickets);
    } catch (error: any) {
      console.error('Get my tickets error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * In-app ticket purchase for a logged-in Keshless user.
   *
   * Reached via the main keshless-api proxy (/tickets/purchase), authenticated
   * by the shared service key (dualAuth). The buyer phone is taken from the
   * proxy-forwarded x-user-phone — never the body — so the ticket binds to the
   * user's own number and shows under their My Tickets. Pays with the user's
   * Keshless card + PIN, exactly like the web buyer checkout (same shared
   * TicketService.purchaseForCustomer, same price x quantity, no add-on fee).
   */
  static async purchaseAsUser(req: Request, res: Response): Promise<any> {
    try {
      const schema = Joi.object({
        eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        ticketTypeId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        quantity: Joi.number().integer().min(1).max(MAX_TICKETS_PER_ORDER).required(),
        customerName: Joi.string().optional().max(100).trim().allow(''),
        keshlessCardNumber: Joi.string().required().length(8).alphanum().uppercase(),
        keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/),
      });

      const { error, value } = schema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Trust ONLY the phone attached by the service-auth middleware from the
      // validated proxy request — never the raw x-user-phone header (a holder
      // of the service key could otherwise bind tickets to any number).
      const ticketsUser = (req as any).ticketsUser;
      const phone = ticketsUser?.userPhone as string | undefined;
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Authenticated user phone required');
      }

      const result = await TicketService.purchaseForCustomer({
        eventId: value.eventId,
        items: value.items,
        customerPhone: phone,
        customerName: value.customerName,
        keshlessCardNumber: value.keshlessCardNumber,
        keshlessPin: value.keshlessPin,
      });

      return ApiResponseUtil.created(res, result, 'Tickets purchased successfully!');
    } catch (error: any) {
      console.error('Purchase (in-app) error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to purchase tickets');
    }
  }

  /**
   * User: Update profile
   */
  static async updateProfile(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const updatedUser = await TicketsAuthService.updateProfile(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string,
        value
      );

      ApiResponseUtil.success(res, updatedUser, 'Profile updated successfully');
    } catch (error: any) {
      console.error('Update profile error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update profile');
    }
  }

  /**
   * User: Change password
   */
  static async changePassword(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = changePasswordSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const { currentPassword, newPassword } = value;

      await TicketsAuthService.changePassword(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string,
        currentPassword,
        newPassword
      );

      ApiResponseUtil.success(res, null, 'Password changed successfully');
    } catch (error: any) {
      console.error('Change password error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to change password');
    }
  }

  /**
   * Events: Get all events
   */
  static async getEvents(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = eventQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      // Pulled OUT of the spread on purpose: `...value` lands after vendorId,
      // so leaving a client-supplied vendorId in it would overwrite the one
      // from the token and let any organizer read another's catalogue. It goes
      // to filterVendorId instead, which only narrows a super-admin's view.
      const { vendorId: requestedVendorId, ...eventQuery } = value;

      const result = await EventService.getEvents({
        vendorId: ticketsUser.vendorId as string,
        ...eventQuery,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...(requestedVendorId ? { filterVendorId: requestedVendorId } : {}),
        // Narrows the event picker (and every other list) to what a restricted
        // operator is actually allowed to work.
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get events error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch events');
    }
  }

  /**
   * Events: Get single event
   */
  static async getEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.getEventById(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      // event.totalTicketsSold / ticketTypes[].sold are persisted counters
      // that include platform-printed wristband/tag batches, which makes
      // them look inflated on the event detail page. Overlay the live,
      // wristband-excluded figures for display — the raw fields are left
      // untouched since other logic (quantity-adjustment guards, the
      // reseller POS remaining-capacity calc) depends on them reflecting
      // true inventory consumption, tags included.
      const salesSummary = await AnalyticsService.getEventSalesSummary(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );
      const soldByType = new Map(salesSummary.ticketTypes.map((t) => [t.name, t.sold]));
      const tagsByType = new Map(salesSummary.tagsPrintedByType.map((t) => [t.name, t.count]));

      const eventJson = typeof (event as any).toObject === 'function' ? (event as any).toObject() : event;
      const responseEvent = {
        ...eventJson,
        ticketTypes: (eventJson.ticketTypes || []).map((tt: any) => ({
          ...tt,
          realSold: soldByType.get(tt.name) || 0,
          tagsPrinted: tagsByType.get(tt.name) || 0
        })),
        salesSummary: {
          ticketsSold: salesSummary.ticketsSold,
          tagsPrinted: salesSummary.tagsPrinted,
          cashSales: salesSummary.cashSales
        }
      };

      // A gate operator holds VIEW_EVENTS only so the POS can pick which show
      // to scan. The organizer's takings are not part of that job: the money
      // fields come off for the door, everything the picker needs stays.
      if (ticketsUser.userType === 'gate-operator') {
        const { totalRevenue: _revenue, totalTicketsSold: _sold, salesSummary: _summary, ...forTheDoor } = responseEvent;
        ApiResponseUtil.success(res, forTheDoor);
        return;
      }

      ApiResponseUtil.success(res, responseEvent);
    } catch (error: any) {
      console.error('Get event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event', 404);
    }
  }

  /**
   * Events: Get the event's creator (organiser) + their event history.
   * Powers the admin "Creator" panel.
   */
  static async getEventCreator(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      // The creator card is the organizer's email, phone, primary contact and
      // the revenue of every event they own. A gate token reaches this route
      // only because VIEW_EVENTS doubles as the POS event picker — the door
      // has no business with the organizer's contact book or their takings.
      if (ticketsUser.userType === 'gate-operator') {
        ApiResponseUtil.forbidden(res, 'Gate operators cannot view organizer details');
        return;
      }

      const summary = await EventService.getEventCreatorSummary(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, summary);
    } catch (error: any) {
      console.error('Get event creator error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event creator', 404);
    }
  }

  /**
   * Events: Create event
   */
  static async createEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = createEventSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      // Carrot Tickets is always the seller for every organizer-created
      // event — organizers are never asked to choose, and nothing they send
      // can override it. (createEventSchema also backs the community
      // self-listing submit path, where 'external' is a legitimate choice,
      // so the restriction lives here rather than in the shared schema.)
      value.ticketing = 'carrot';
      delete value.externalTicketUrl;

      const event = await EventService.createEvent({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...value
      });

      ApiResponseUtil.created(res, event, 'Event created successfully');
    } catch (error: any) {
      // Preserve the cashless gate's 403; anything else stays a generic failure.
      return failWithHttpError(res, error, 'Failed to create event');
    }
  }

  /**
   * Events: Organizer asks Carrot to enable cashless on their event.
   * POST /api/tickets/events/:eventId/cashless-request
   */
  static async requestCashless(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const { error, value } = cashlessRequestSchema.validate(req.body ?? {});
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const event = await EventService.requestCashless(
        eventId as string,
        ticketsUser.vendorId as string,
        value.note
      );

      ApiResponseUtil.success(res, event, 'Cashless requested — Carrot will be in touch');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to request cashless');
    }
  }

  /**
   * Events: Update event
   */
  static async updateEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      // Validate input
      const { error, value } = updateEventSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      // Carrot Tickets is always the seller for every event — organizers can
      // never switch an event to external ticketing (or back), so drop any
      // attempt to change it here rather than in the shared schema (which
      // also backs the community self-listing submit path).
      delete value.ticketing;
      delete value.externalTicketUrl;

      const event = await EventService.updateEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Event updated successfully');
    } catch (error: any) {
      // Preserve the rename guard's 403 (and any other HttpError status);
      // anything else logs loudly and becomes a 500.
      return failWithHttpError(res, error, 'Failed to update event');
    }
  }

  /**
   * Events: Delete event
   */
  static async deleteEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      await EventService.deleteEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, null, 'Event deleted successfully');
    } catch (error: any) {
      console.error('Delete event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to delete event');
    }
  }

  /**
   * Events: Publish event
   */
  static async publishEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.publishEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      // Message reflects where the event actually landed: a superadmin publish
      // goes live; an organizer publish is submitted for approval.
      const message = event.status === EventStatus.PENDING_APPROVAL
        ? 'Event submitted for approval'
        : 'Event published successfully';

      ApiResponseUtil.success(res, event, message);
    } catch (error: any) {
      console.error('Publish event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to publish event');
    }
  }

  /**
   * Events: Unpublish event
   */
  static async unpublishEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.unpublishEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Event unpublished successfully');
    } catch (error: any) {
      console.error('Unpublish event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to unpublish event');
    }
  }

  /**
   * Ticket Types: Add ticket type to event
   */
  static async addTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;
      const { error, value } = Joi.object({
        name: Joi.string().required().trim().max(100),
        description: Joi.string().optional().max(500),
        price: Joi.number().required().min(0),
        quantity: Joi.number().required().min(1),
        // Reseller allocation block (super-admin only — enforced in the service).
        isAllocation: Joi.boolean().optional(),
        resellerId: Joi.string().hex().length(24).optional(),
        allocationUnitCost: Joi.number().min(0).optional(),
        restrictToMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
        waiveServiceFee: Joi.boolean().optional(),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.addTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type added successfully');
    } catch (error: any) {
      console.error('Add ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to add ticket type');
    }
  }

  /**
   * Ticket Types: Update ticket type
   */
  static async updateTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        name: Joi.string().optional().trim().max(100),
        description: Joi.string().optional().max(500),
        price: Joi.number().optional().min(0),
        quantity: Joi.number().optional().min(1)
      }).min(1).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.updateTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type updated successfully');
    } catch (error: any) {
      console.error('Update ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update ticket type');
    }
  }

  /**
   * Ticket Types: Delete ticket type
   */
  static async deleteTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;

      const event = await EventService.deleteTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type deleted successfully');
    } catch (error: any) {
      console.error('Delete ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to delete ticket type');
    }
  }

  /**
   * Ticket Types: Adjust quantity
   */
  static async adjustTicketQuantity(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        adjustment: Joi.number().required().not(0).messages({
          'any.required': 'Adjustment value is required',
          'any.invalid': 'Adjustment cannot be zero'
        })
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.adjustTicketQuantity(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value.adjustment,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket quantity adjusted successfully');
    } catch (error: any) {
      console.error('Adjust ticket quantity error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to adjust ticket quantity');
    }
  }

  /**
   * Ticket Types: Mark as sold out
   */
  static async markTicketSoldOut(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        isSoldOut: Joi.boolean().required()
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.markTicketSoldOut(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value.isSoldOut,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket sold-out status updated successfully');
    } catch (error: any) {
      console.error('Mark ticket sold out error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update sold-out status');
    }
  }

  /**
   * Sales: Sell tickets
   */
  static async sellTickets(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = sellTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      if (!(await operatorMayActOnEvent(req, value.eventId))) {
        ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
        return;
      }

      // Accepts a basket or the legacy single-tier pair: the dashboard's Sell
      // Tickets page ships separately from this API, so both shapes have to
      // work during the changeover. The spread is why TypeScript cannot see a
      // shape change here, which is why the cart is built explicitly.
      const { items, ticketTypeId, quantity, ...rest } = value as {
        items?: Array<{ ticketTypeId: string; quantity: number; recipients?: Array<{ name?: string; phone?: string; email?: string }> }>;
        ticketTypeId?: string;
        quantity?: number;
      } & Record<string, unknown>;

      const lines = Array.isArray(items) && items.length > 0
        ? items
        : [{ ticketTypeId: ticketTypeId as string, quantity: quantity ?? 1 }];

      const result = await TicketService.sellTickets({
        ...(rest as Omit<Parameters<typeof TicketService.sellTickets>[0], 'vendorId' | 'soldBy' | 'soldByType' | 'lines'>),
        vendorId: ticketsUser.vendorId as string,
        soldBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        soldByType: ticketsUser.userType === 'vendor' ? 'vendor' : 'sub-user',
        lines,
      });

      ApiResponseUtil.created(
        res,
        {
          sale: result.sale,
          tickets: result.tickets
        },
        result.paymentMessage || 'Tickets sold successfully'
      );
    } catch (error: any) {
      console.error('Sell tickets error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to sell tickets');
    }
  }

  /**
   * Sales: (re)send the ticket confirmation SMS for a sale on this vendor's
   * own event. A box-office sale notifies nobody at sale time, so this is the
   * only way the walk-up buyer receives their ticket digitally.
   *
   * A gateway rejection is surfaced as 502 rather than a 200 with sent:false,
   * so the till never shows success for a message that was not accepted.
   */
  static async sendSaleSms(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      const { error, value } = Joi.object({
        saleId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
      }).validate(req.params);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { sent } = await TicketService.sendSaleSmsForVendor(
        value.saleId,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false,
      );

      if (!sent) {
        return ApiResponseUtil.error(res, 'SMS gateway did not accept the message', 502);
      }

      return ApiResponseUtil.success(res, { sent }, 'Ticket SMS sent');
    } catch (err: any) {
      const msg = err?.message || '';
      if (/not authorized/i.test(msg)) {
        return ApiResponseUtil.error(res, 'Not authorized to send SMS for this sale', 403);
      }
      if (/no customer phone|no issued tickets/i.test(msg)) {
        return ApiResponseUtil.error(res, msg, 400);
      }
      if (/event not found/i.test(msg)) {
        console.error('Send sale SMS error (orphaned event):', err);
        return ApiResponseUtil.error(res, 'Internal error: event data missing for this sale', 500);
      }
      if (/not found/i.test(msg)) {
        return ApiResponseUtil.error(res, 'Sale not found', 404);
      }
      console.error('Send sale SMS error:', err);
      return ApiResponseUtil.error(res, msg || 'Failed to send ticket SMS');
    }
  }

  /**
   * Sales: Get sales
   */
  static async getSales(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = ticketSalesQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketService.getSales({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...value
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get sales error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sales');
    }
  }

  /**
   * Sales: Get single sale
   */
  static async getSale(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { saleId } = req.params;

      const sale = await TicketService.getSaleById(saleId as string, ticketsUser.vendorId as string);

      ApiResponseUtil.success(res, sale);
    } catch (error: any) {
      console.error('Get sale error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sale', 404);
    }
  }

  /**
   * Sales: Refund ticket
   */
  static async refundTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { ticketId } = req.params;

      // Validate input
      const { error, value } = refundTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const ticket = await TicketService.refundTicket(
        ticketId as string,
        ticketsUser.vendorId as string,
        value.reason
      );

      ApiResponseUtil.success(res, ticket, 'Ticket refunded successfully');
    } catch (error: any) {
      console.error('Refund ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to refund ticket');
    }
  }

  /**
   * Scans: Validate ticket
   */
  static async validateTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = validateTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const scannedByType =
        ticketsUser.userType === 'vendor' ? 'vendor'
        : ticketsUser.userType === 'gate-operator' ? 'gate-operator'
        : 'sub-user';

      const result = await ScanService.validateTicket({
        ticketId: value.ticketId,
        vendorId: ticketsUser.vendorId as string,
        scannedBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        scannedByType,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        expectedEventId: value.expectedEventId,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
      });

      if (result.valid) {
        ApiResponseUtil.success(res, result, result.message);
      } else {
        ApiResponseUtil.error(res, result.message, 400, result);
      }
    } catch (error: any) {
      console.error('Validate ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to validate ticket');
    }
  }

  /**
   * Scans: Check-in ticket
   */
  static async checkInTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = checkInTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      // Resolve a tapped band's uid to a ticket BEFORE handing off to
      // ScanService.checkInTicket — the QR/ticketId path below is otherwise
      // completely unchanged. `findTicketByCode` (used inside checkInTicket)
      // only matches Ticket.ticketId (the short code), never `_id`, but
      // Wallet.ticketId stores the Ticket's `_id` — so the ticket must be
      // loaded by `_id` here first and its short code passed through.
      let ticketId = value.ticketId;
      if (value.bandUid) {
        const eventId = value.expectedEventId;
        if (!eventId) {
          return ApiResponseUtil.error(res, 'expectedEventId is required for band check-in', 400);
        }

        const event = await Event.findById(eventId).lean();
        if (!event) {
          return ApiResponseUtil.error(res, 'Event not found', 404);
        }
        if (!event.cashless) {
          return ApiResponseUtil.error(res, 'Event is not cashless', 400);
        }
        // Vendor-ownership guard BEFORE any band/wallet lookup: an operator may
        // only resolve bands at their OWN event. ScanService.checkInTicket also
        // enforces the vendor check, but doing it here first closes a
        // cross-tenant existence leak (whether a uid is bound at another vendor's
        // event). Mirrors ScanService.bindBandToTicket's vendor check.
        if (!ticketsUser.isSuperAdmin && String(event.vendorId) !== ticketsUser.vendorId) {
          return ApiResponseUtil.error(res, 'Event belongs to a different vendor', 403);
        }
        // Same assignment guard as the QR path, applied before any band/wallet
        // lookup so a restricted operator cannot probe bands at another show.
        if (!(await operatorMayActOnEvent(req, String(eventId)))) {
          return ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
        }

        const wallet = await Wallet.findOne({ eventId, bandUid: normalizeBandUid(value.bandUid) });
        if (!wallet) {
          return ApiResponseUtil.error(res, 'No wallet bound to that band in this event', 400);
        }

        // A tag handed out on its own carries a wallet but no ticket (design
        // 2026-09-05), so it can spend but cannot admit. Answer that plainly:
        // falling through to the lookup below would findById(undefined) and
        // report "Ticket not found for that wallet", which reads like corrupt
        // data and sends the gate hunting for a problem that does not exist.
        if (!wallet.ticketId) {
          return ApiResponseUtil.error(
            res,
            'That tag is a spending tag — there is no ticket behind it, so it cannot be used for entry',
            400,
          );
        }

        const ticket = await Ticket.findById(wallet.ticketId);
        if (!ticket) {
          return ApiResponseUtil.error(res, 'Ticket not found for that wallet', 400);
        }
        ticketId = ticket.ticketId;
      }

      const scannedByType =
        ticketsUser.userType === 'vendor' ? 'vendor'
        : ticketsUser.userType === 'gate-operator' ? 'gate-operator'
        : 'sub-user';

      const result = await ScanService.checkInTicket({
        ticketId,
        vendorId: ticketsUser.vendorId as string,
        scannedBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        scannedByType,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        notes: value.notes,
        expectedEventId: value.expectedEventId,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
      });

      if (result.valid) {
        ApiResponseUtil.success(res, result, result.message);
      } else {
        ApiResponseUtil.error(res, result.message, 400, result);
      }
    } catch (error: any) {
      console.error('Check-in ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to check in ticket');
    }
  }

  /**
   * Scans: Bind a blank NFC band to a scanned ticket's cashless wallet
   * (cashless spec §5.1). Independent of turnstile check-in — does NOT flip
   * the ticket's entry-scan status, so a dedicated band desk can bind without
   * tripping an "already checked in" error.
   */
  static async bindBand(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = bindBandSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await ScanService.bindBandToTicket({
        ticketId: value.ticketId,
        bandUid: value.bandUid,
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        expectedEventId: value.expectedEventId,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
        boundBy: (ticketsUser.userId || ticketsUser.vendorId) as string
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Bind band error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to bind band', 400);
    }
  }

  /**
   * Scans: Reissue a lost band for a ticket's cashless wallet (cashless spec
   * §5.1) — unbinds the old uid and binds a new one on the same wallet, so the
   * balance is preserved. Mirrors bindBand's vendor ownership + event-lock
   * enforcement exactly.
   */
  static async reissueBand(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = reissueBandSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await ScanService.reissueBandForTicket({
        ticketId: value.ticketId,
        newBandUid: value.newBandUid,
        reason: value.reason,
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        expectedEventId: value.expectedEventId,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
        boundBy: (ticketsUser.userId || ticketsUser.vendorId) as string
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Reissue band error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to reissue band', 400);
    }
  }

  /**
   * Gate: Look up a tapped band's cashless wallet (cashless spec §5.1/§5.3) —
   * balance, cash-funded portion, status, and recent top-up history. Read-only,
   * gated by the same SCAN_TICKETS permission as the rest of the gate flow.
   * eventId is required (a band uid is only unique per event) and must be a
   * 24-hex ObjectId; anything else is a 400, not a 500.
   */
  static async walletByBand(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const uid = normalizeBandUid(req.params.uid as string);
      const eventId = String(req.query.eventId || '');
      if (!/^[0-9a-fA-F]{24}$/.test(eventId)) {
        return ApiResponseUtil.error(res, 'eventId is required', 400);
      }

      // Vendor-ownership guard: an operator may only read bands at their OWN
      // event. Mirrors ScanService.bindBandToTicket's vendor check. Without this,
      // any operator with SCAN_TICKETS could read another vendor's attendees'
      // wallet balances by guessing a band uid + event id. 403 (not 404) so the
      // rejection is honest rather than leaking existence.
      const event = await Event.findById(eventId).lean();
      if (!event) {
        return ApiResponseUtil.error(res, 'No wallet bound to that band in this event', 404);
      }
      if (!(await operatorMayActOnEvent(req, eventId))) {
        return ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
      }
      if (!ticketsUser.isSuperAdmin && String(event.vendorId) !== ticketsUser.vendorId) {
        return ApiResponseUtil.forbidden(res, 'This event belongs to a different vendor');
      }

      const view = await WalletService.getWalletViewByBand(uid, eventId);
      if (!view) {
        return ApiResponseUtil.error(res, 'No wallet bound to that band in this event', 404);
      }

      return ApiResponseUtil.success(res, view);
    } catch (error: any) {
      console.error('Wallet by band error:', error);
      return ApiResponseUtil.error(res, error.message || 'Lookup failed', 500);
    }
  }

  /**
   * Scans: Get scans
   */
  static async getScans(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = scanQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await ScanService.getScans({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...value,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get scans error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch scans');
    }
  }

  /**
   * Entry Scanning: Aggregate scan statistics for the Entry Scan analytics row
   */
  static async getScanStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query (reuses the analytics schema: eventId/startDate/endDate)
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await ScanService.getScanStats({
        vendorId: ticketsUser.vendorId as string,
        eventId: value.eventId,
        startDate: value.startDate,
        endDate: value.endDate,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        allowedEventIds: (await resolveOperatorEventScope(req)) ?? undefined,
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get scan stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch scan statistics');
    }
  }

  /**
   * Analytics: Get dashboard stats
   */
  static async getDashboardStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getDashboardStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get dashboard stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch dashboard statistics');
    }
  }

  /**
   * Analytics: Get sales stats
   */
  static async getSalesStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getSalesStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get sales stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sales statistics');
    }
  }

  /**
   * Analytics: Get revenue stats
   */
  static async getRevenueStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getRevenueStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get revenue stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch revenue statistics');
    }
  }

  /**
   * Analytics: Get event analytics
   */
  static async getEventAnalytics(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const analytics = await AnalyticsService.getEventAnalytics(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, analytics);
    } catch (error: any) {
      console.error('Get event analytics error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event analytics');
    }
  }

  /**
   * Analytics: Full money breakdown for one event — per payment method, per
   * sales channel, and where the proceeds physically are. Behind VIEW_REVENUE
   * rather than VIEW_STATS because it exposes proceeds and custody, not just
   * counts.
   */
  static async getEventFinancials(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const financials = await EventFinancialsService.getEventFinancials(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      return ApiResponseUtil.success(res, financials);
    } catch (error: any) {
      // failWithHttpError, not a bare 500 — the service's 404 for an event this
      // vendor doesn't own has to survive, or a missing event reads as an outage.
      return failWithHttpError(res, error, 'Failed to fetch event financials');
    }
  }

  /**
   * Export: Export sales
   */
  static async exportSales(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate, like getSales does — an unrecognised filter must 400 rather
      // than silently match nothing and hand back an empty CSV.
      const { error, value } = ticketSalesExportQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }
      const { eventId, startDate, endDate, paymentMethod, paymentStatus, channel } = value;

      // Same filter set the Sales History page shows on screen — an export
      // that ignored them returned rows the visible table had excluded.
      // `isSuperAdmin` is what keeps paymentStatus from widening an
      // organizer's visibility; the service asserts that too.
      const csv = await ExportService.exportSalesToCSV({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        eventId: eventId as string,
        paymentMethod: paymentMethod as PaymentMethod | undefined,
        paymentStatus: paymentStatus as PaymentStatus | undefined,
        channel: channel as SalesChannel | undefined,
        // Joi has already coerced these to Date objects.
        startDate,
        endDate
      });

      const filename = ExportService.getFilename('sales');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export sales error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export sales');
    }
  }

  /**
   * Export: Export revenue
   */
  static async exportRevenue(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, startDate, endDate } = req.query;

      const csv = await ExportService.exportRevenueToCSV({
        vendorId: ticketsUser.vendorId as string,
        eventId: eventId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });

      const filename = ExportService.getFilename('revenue');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export revenue error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export revenue');
    }
  }

  /**
   * Export: Export event summary
   */
  static async exportEventSummary(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const csv = await ExportService.exportEventSummaryToCSV(
        eventId as string,
        ticketsUser.vendorId as string
      );

      const filename = ExportService.getFilename('event_summary');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export event summary error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export event summary');
    }
  }
}
