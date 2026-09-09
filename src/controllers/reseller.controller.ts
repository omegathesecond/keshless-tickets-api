import { Request, Response } from 'express';
import Joi from 'joi';
import { resolveOperatorEventScope, operatorMayActOnEvent } from '@services/operatorEventScope.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { ResellerSaleService } from '@services/resellerSale.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EventService } from '@services/event.service';
import { AllocationService } from '@services/allocation.service';
import { EventStatus } from '@interfaces/event.interface';
import { cashTopupSchema } from '@validators/reseller.validator';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { WalletService, WalletIdempotencyMismatchError } from '@services/wallet.service';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';

export class ResellerController {
  /**
   * Owner login by email + password (allocation-portal partners like DeltaPay).
   */
  static async ownerLogin(req: Request, res: Response): Promise<any> {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return ApiResponseUtil.error(res, 'Email and password are required', 400);
      }
      const result = await ResellerAuthService.ownerLogin(email, password);
      return ApiResponseUtil.success(res, result, 'Signed in successfully');
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Failed to sign in', 401);
    }
  }

  /**
   * Allocation: this reseller's pre-bought blocks (sold / remaining / collected).
   * Scoped strictly to the authenticated reseller — never the organizer's data.
   */
  static async getMyAllocation(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;
      const data = await AllocationService.getForReseller(reseller.resellerId);
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      console.error('Get allocation error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load allocation');
    }
  }

  /**
   * Authentication: Login with login code + PIN
   */
  static async login(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = Joi.object({
        // Login codes are now Crockford base32 (letters + digits), not
        // 6-digit-numeric-only. Case-insensitive alnum only gates obviously
        // malformed input — the service's normalizeLoginCode owns folding
        // case and the I/L/O ambiguous glyphs, validation should not
        // duplicate that logic.
        loginCode: Joi.string().pattern(/^[0-9A-Za-z]{6}$/).required(),
        pin: Joi.string().pattern(/^\d{6}$/).required(),
      }).or('items', 'ticketTypeId').validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const result = await ResellerAuthService.login(value.loginCode, value.pin);
      return ApiResponseUtil.success(res, result, 'Login successful');
    } catch (err: any) {
      if (err?.message === 'Invalid credentials') {
        return ApiResponseUtil.unauthorized(res, 'Invalid credentials');
      }
      if (typeof err?.message === 'string' && err.message.includes('locked')) {
        return ApiResponseUtil.error(res, err.message, 429);
      }
      console.error('Reseller login error:', err);
      return ApiResponseUtil.error(res, 'Login failed', 500);
    }
  }

  /**
   * Events: List published events platform-wide
   */
  static async getEvents(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        search: Joi.string().optional().trim(),
        startDate: Joi.date().iso().optional(),
        endDate: Joi.date().iso().optional(),
      }).validate(req.query);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Resellers are a platform-wide channel — pass a dummy vendorId and
      // isSuperAdmin=true so EventService.getEvents skips vendor scoping — but
      // an ASSIGNED reseller sees only its own events. null means unassigned,
      // which stays platform-wide; [] means assigned to nothing and lists
      // nothing, so the value is passed through as-is rather than length-checked.
      const allowedEventIds = await resolveOperatorEventScope(req);

      const result = await EventService.getEvents({
        vendorId: '',
        status: EventStatus.PUBLISHED,
        isSuperAdmin: true,
        ...value,
        ...(allowedEventIds ? { allowedEventIds } : {}),
      });

      return ApiResponseUtil.success(res, result);
    } catch (err: any) {
      console.error('Reseller get events error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch events');
    }
  }

  /**
   * Events: Get ticket types + remaining capacity for a single event
   */
  static async getEventTickets(req: Request, res: Response): Promise<any> {
    try {
      const { id } = req.params;

      // Refuse before the lookup: an assigned reseller has no business reading
      // the tier names, prices or remaining capacity of somebody else's show.
      if (!(await operatorMayActOnEvent(req, id))) {
        return ApiResponseUtil.forbidden(res, 'This event is not assigned to you');
      }

      // getEventById with isSuperAdmin=true so we can see any event by id
      const event = await EventService.getEventById(id as string, '', true);

      if (event.status !== EventStatus.PUBLISHED) {
        return ApiResponseUtil.error(res, 'Event is not published', 404);
      }

      // Shape ticket types with remaining capacity for the POS
      const ticketTypes = (event.ticketTypes || []).map((tt: any) => ({
        id: tt._id,
        name: tt.name,
        description: tt.description,
        price: tt.price,
        quantity: tt.quantity,
        sold: tt.sold,
        reserved: tt.reserved || 0,
        remaining: Math.max(0, tt.quantity - tt.sold - (tt.reserved || 0)),
        isSoldOut: tt.isSoldOut || false,
      }));

      return ApiResponseUtil.success(res, { event: { id: event._id, name: event.name, venue: event.venue, eventDate: event.eventDate }, ticketTypes });
    } catch (err: any) {
      if (/not found/i.test(err?.message)) {
        return ApiResponseUtil.error(res, 'Event not found', 404);
      }
      console.error('Reseller get event tickets error:', err);
      return ApiResponseUtil.error(res, 'Failed to fetch event tickets', 500);
    }
  }

  /**
   * Payment Methods: Return enabled methods from PaymentConfigService
   */
  static async getPaymentMethods(req: Request, res: Response): Promise<any> {
    try {
      const cfg = await PaymentConfigService.get();

      const methods: string[] = [];
      if (cfg.cashEnabled) methods.push('cash');
      // MoMo requires BOTH the admin toggle AND the processor being configured
      // (MTN_MOMO_ENABLED + creds). Mirrors PublicController.getPaymentMethods so
      // the till never offers MoMo when initiateMomoPurchase would throw
      // "MTN MoMo is not available".
      if (cfg.mtnMomoEnabled && process.env['MTN_MOMO_ENABLED'] === 'true') methods.push('mtn_momo');
      if (cfg.keshlessWalletEnabled) methods.push('keshless_wallet');

      return ApiResponseUtil.success(res, { methods });
    } catch (err: any) {
      console.error('Reseller get payment methods error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch payment methods');
    }
  }

  /**
   * Sales: Create a POS sale — operatorId/resellerId/hubId from req.reseller only
   */
  static async createSale(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;

      const { error, value } = Joi.object({
        eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        // A basket, or the legacy single-tier pair the Flutter POS still
        // sends. The till app ships on its own cycle, so the API cannot
        // require the new shape until that build is out — see cartItemsFrom.
        items: Joi.array()
          .items(Joi.object({
            ticketTypeId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
            quantity: Joi.number().integer().min(1).max(20).required(),
          }))
          .min(1).max(20).optional(),
        ticketTypeId: Joi.string().optional().regex(/^[0-9a-fA-F]{24}$/),
        quantity: Joi.number().integer().min(1).max(20).optional(),
        paymentMethod: Joi.string().valid('cash', 'mtn_momo', 'keshless_wallet').required(),
        customerName: Joi.string().optional().max(100).trim().allow(''),
        customerPhone: Joi.string().optional().trim().allow(''),
        momoPhone: Joi.string().optional().trim().allow(''),
        keshlessCardNumber: Joi.string().optional().length(8).alphanum().uppercase(),
        keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // The real chokepoint. Hiding an event from the list does nothing on its
      // own: event ids are public (they sit in /event/<slug>-<24hex> URLs), so
      // an unassigned event is one hand-rolled POST away without this.
      if (!(await operatorMayActOnEvent(req, value.eventId))) {
        return ApiResponseUtil.forbidden(res, 'This event is not assigned to you');
      }

      // The spread is why TypeScript cannot see a shape change here, so the
      // cart is resolved explicitly rather than riding along in `value`.
      const { items: _items, ticketTypeId: _tt, quantity: _q, ...rest } = value;
      const items = Array.isArray(value.items) && value.items.length > 0
        ? value.items
        : [{ ticketTypeId: value.ticketTypeId, quantity: value.quantity ?? 1 }];

      const result = await ResellerSaleService.createSale({
        // Trust ONLY values from the verified JWT — never client-supplied ids
        operatorId: reseller.operatorId,
        resellerId: reseller.resellerId,
        hubId: reseller.hubId ?? '',
        ...rest,
        items,
      });

      // MoMo is async: surface the PENDING payload (referenceId/expiresAt) so the
      // till can poll/finalize. Cash/keshless return the completed payload.
      const message =
        result.status === 'pending'
          ? 'MoMo payment initiated — awaiting confirmation'
          : (result as { message?: string }).message || 'Sale completed';

      return ApiResponseUtil.created(res, result, message);
    } catch (err: any) {
      console.error('Reseller create sale error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to create sale');
    }
  }

  /**
   * Sales: Finalize a MoMo sale by referenceId — scoped to the owning reseller.
   * Maps not-found → 404, ownership failure → 403, else success.
   */
  static async finalizeSale(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;
      const { referenceId } = req.params;

      const result = await ResellerSaleService.finalizeSale(
        referenceId as string,
        reseller.resellerId
      );

      return ApiResponseUtil.success(res, result, 'Sale finalized');
    } catch (err: any) {
      const msg = err?.message || '';
      if (/not found/i.test(msg)) {
        return ApiResponseUtil.notFound(res, 'Sale not found');
      }
      if (/not authorized/i.test(msg)) {
        return ApiResponseUtil.forbidden(res, 'Not authorized to finalize this sale');
      }
      console.error('Reseller finalize sale error:', err);
      return ApiResponseUtil.error(res, msg || 'Failed to finalize sale');
    }
  }

  /**
   * Sales: (re)send the ticket confirmation SMS for a sale this reseller owns.
   * Returns the boolean send result; a gateway rejection is surfaced as 502 so
   * the till never shows success for a message that wasn't accepted.
   */
  static async sendSaleSms(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;

      const { error, value } = Joi.object({
        saleId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
      }).validate(req.params);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { sent } = await ResellerSaleService.sendSaleSms(value.saleId, reseller.resellerId);

      if (!sent) {
        return ApiResponseUtil.error(res, 'SMS gateway did not accept the message', 502);
      }

      return ApiResponseUtil.success(res, { sent }, 'Ticket SMS sent');
    } catch (err: any) {
      const msg = err?.message || '';
      if (/event not found/i.test(msg)) {
        console.error('Reseller send sale SMS error (orphaned event):', err);
        return ApiResponseUtil.error(res, 'Internal error: event data missing for this sale', 500);
      }
      if (/not found/i.test(msg)) {
        return ApiResponseUtil.notFound(res, 'Sale not found');
      }
      if (/not authorized/i.test(msg)) {
        return ApiResponseUtil.forbidden(res, 'Not authorized to send SMS for this sale');
      }
      if (/no customer phone|no issued tickets/i.test(msg)) {
        return ApiResponseUtil.badRequest(res, msg);
      }
      console.error('Reseller send sale SMS error:', err);
      return ApiResponseUtil.error(res, msg || 'Failed to send SMS');
    }
  }

  /**
   * Sales: List own sales scoped to req.reseller.operatorId + resellerId
   */
  static async getSales(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;

      const { error, value } = Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        startDate: Joi.date().iso().optional(),
        endDate: Joi.date().iso().optional(),
      }).validate(req.query);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { page = 1, limit = 20, startDate, endDate } = value;

      // Scope strictly to this operator's own sales — never trust client-supplied ids
      const { sales, total } = await ResellerSaleService.getOperatorSales({
        operatorId: reseller.operatorId,
        resellerId: reseller.resellerId,
        page,
        limit,
        startDate,
        endDate,
      });

      return ApiResponseUtil.success(res, {
        data: sales,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1,
        },
      });
    } catch (err: any) {
      console.error('Reseller get sales error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch sales');
    }
  }

  /**
   * Wallets: Cash top-up at a desk (spec §5.2). Resolves the wallet by bandUid
   * OR ticketId (xor'd in the schema), gates on Event.cashless, and delegates
   * the atomic credit + ledger posting to WalletService.topUpCash. recordedBy
   * comes ONLY from the verified JWT (req.reseller.operatorId), never the body.
   */
  static async cashTopup(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = cashTopupSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      // Same chokepoint as /sales: event ids are public, so without this a
      // till assigned to event A could credit wallets at event B.
      if (!(await operatorMayActOnEvent(req, value.eventId))) {
        return ApiResponseUtil.forbidden(res, 'You are not assigned to this event');
      }

      const event = await Event.findById(value.eventId).lean();
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);
      // Lifecycle guard: only a live (PUBLISHED) event can take top-ups, mirroring
      // ResellerSaleService.createSale. Blocks loading a band at a cancelled or
      // not-yet-live event.
      if (event.status !== EventStatus.PUBLISHED) {
        return ApiResponseUtil.error(res, 'Event is not published', 400);
      }

      const wallet = value.bandUid
        ? await Wallet.findOne({ eventId: value.eventId, bandUid: value.bandUid })
        : await Wallet.findOne({ ticketId: value.ticketId, eventId: value.eventId });
      if (!wallet) return ApiResponseUtil.error(res, 'No wallet for that band/ticket', 404);

      const result = await WalletService.topUpCash({
        walletId: String(wallet._id), eventId: value.eventId,
        amount: value.amount, recordedBy: (req as any).reseller.operatorId, clientTxnId: value.clientTxnId,
      });
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      if (e instanceof WalletIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409);
      const msg = e?.message || 'Top-up failed';
      const status = /not active|not found|cashless|amount/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

}
