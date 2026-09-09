import { Request, Response } from 'express';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { MenuItem } from '@models/menuItem.model';
import { MenuOrder } from '@models/menuOrder.model';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { MenuOrderService } from '@services/menuOrder.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { createMenuOrderSchema } from '@validators/menu.validator';
import { HttpError } from '@utils/httpError.util';

/**
 * A known checkout refusal carries its own status (MenuOrderService throws
 * HttpError: 404 event closed, 400 PIN/cap, 402 payment declined, 409 item
 * gone, 503 MoMo unavailable); a malformed id is a Mongoose CastError → 400.
 * Anything else is a real failure and stays a 500.
 */
function knownPreorderRefusal(error: any): { status: number; message: string } | null {
  if (error instanceof HttpError) return { status: error.statusCode, message: error.message };
  if (error?.name === 'CastError') return { status: 400, message: 'Invalid event or menu item id' };
  return null;
}

export class MenuPublicController {
  /**
   * GET /api/public/events/:eventId/menu
   * Active items grouped by section/category, plus the payment methods and
   * the current Carrot service-charge percentage so checkout can show a live
   * breakdown before the buyer commits.
   */
  static async getEventMenu(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const event = await Event.findOne({ _id: eventId, status: EventStatus.PUBLISHED }).lean();
      if (!event) return ApiResponseUtil.notFound(res, 'Event not found or not available');

      const items = await MenuItem.find({ eventId, active: true })
        .sort({ section: 1, category: 1, displayOrder: 1, name: 1 })
        .lean();

      const cfg = await PaymentConfigService.get();
      const methods: string[] = [];
      if (cfg.keshlessWalletEnabled) methods.push(PaymentMethod.KESHLESS_WALLET);
      if (cfg.mtnMomoEnabled && process.env['MTN_MOMO_ENABLED'] === 'true') methods.push(PaymentMethod.MTN_MOMO);

      return ApiResponseUtil.success(res, {
        items,
        paymentMethods: methods,
        serviceFeePercent: cfg.menuServiceFeePercent,
      });
    } catch (error: any) {
      console.error('Get event menu error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load menu');
    }
  }

  /**
   * POST /api/public/events/:eventId/menu-orders
   * Place a preorder. Identity comes from the authenticated buyer, never the
   * body. keshless_wallet resolves synchronously; mtn_momo returns a
   * referenceId to poll (see getMomoOrderStatus).
   */
  static async createOrder(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = createMenuOrderSchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.details[0]?.message || 'Validation error');

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to preorder');

      const eventId = req.params['eventId']!;
      const buyerName = (value.buyerName as string | undefined)?.trim() || buyer.name || buyer.phone || buyer.email || 'Guest';

      if (value.paymentMethod === PaymentMethod.KESHLESS_WALLET) {
        const order = await MenuOrderService.createKeshlessOrder({
          eventId,
          buyerId: String(buyer._id),
          buyerName,
          buyerPhone: buyer.phone,
          items: value.items,
          keshlessCardNumber: value.keshlessCardNumber,
          keshlessPin: value.keshlessPin,
          notes: value.notes,
        });
        return ApiResponseUtil.created(res, order, 'Order placed!');
      }

      if (value.paymentMethod === PaymentMethod.MTN_MOMO) {
        const r = await MenuOrderService.initiateMomoOrder({
          eventId,
          buyerId: String(buyer._id),
          buyerName,
          buyerPhone: buyer.phone,
          items: value.items,
          momoPhone: value.momoPhone,
          notes: value.notes,
        });
        return ApiResponseUtil.success(res, r);
      }

      return ApiResponseUtil.badRequest(res, 'Unsupported payment method');
    } catch (error: any) {
      const refusal = knownPreorderRefusal(error);
      if (refusal) return ApiResponseUtil.error(res, refusal.message, refusal.status);
      console.error('Create menu order error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to place order');
    }
  }

  /**
   * GET /api/public/menu-orders/momo/:referenceId/status
   * Poll a pending MoMo preorder and finalize when MTN reports SUCCESSFUL.
   */
  static async getMomoOrderStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');

      const referenceId = req.params['referenceId']!;
      const order = await MenuOrderService.getMomoOrderByReference(referenceId);
      if (!order || String(order.buyerId) !== String(buyer._id)) {
        return ApiResponseUtil.notFound(res, 'Order not found');
      }

      const result = await MenuOrderService.finalizeMomoOrder(referenceId);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Status check failed', error instanceof HttpError ? error.statusCode : 400);
    }
  }

  /**
   * GET /api/public/my-menu-orders — the signed-in buyer's preorder history,
   * newest first, for the "My Orders" tab. Populates just enough of the event
   * and vendor to render a card (name/poster/venue, business name) without a
   * second round-trip per order — never anything payment- or PII-adjacent
   * beyond what the buyer already owns.
   */
  static async getMyOrders(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in');
      const orders = await MenuOrder.find({ buyerId: buyer._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('eventId', 'name posterUrl venue eventDate currency')
        .populate('vendorId', 'businessName')
        .lean();
      return ApiResponseUtil.success(res, orders);
    } catch (error: any) {
      return ApiResponseUtil.error(res, error.message || 'Failed to load orders');
    }
  }
}
