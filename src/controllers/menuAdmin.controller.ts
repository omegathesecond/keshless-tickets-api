import { NextFunction, Request, Response } from 'express';
import { Event } from '@models/event.model';
import { MenuItem } from '@models/menuItem.model';
import { MenuOrder, MenuOrderFulfillmentStatus, fulfillmentTransitionRefusal } from '@models/menuOrder.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import {
  createMenuItemSchema,
  updateMenuItemSchema,
  updateMenuOrderFulfillmentSchema,
  scanMenuOrderSchema,
} from '@validators/menu.validator';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

// Mirrors StockAdminController.loadOwnedEvent — a menu op is only allowed by
// the owner of the event it belongs to (super-admin bypasses).
async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

export class MenuAdminController {
  /** POST /api/tickets/events/:eventId/menu-items */
  static async createItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = createMenuItemSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const item = await MenuItem.create({ ...value, eventId: event._id });
      ApiResponseUtil.created(res, item);
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/menu-items */
  static async listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const items = await MenuItem.find({ eventId: event._id }).sort({ section: 1, category: 1, displayOrder: 1, name: 1 });
      ApiResponseUtil.success(res, items);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/menu-items/:id */
  static async updateItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const item = await MenuItem.findById(req.params['id']);
      if (!item) { ApiResponseUtil.notFound(res, 'Menu item not found'); return; }
      const event = await loadOwnedEvent(req, res, String(item.eventId));
      if (!event) return;
      const { error, value } = updateMenuItemSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      Object.assign(item, value);
      await item.save();
      ApiResponseUtil.success(res, item);
    } catch (err) { next(err); }
  }

  /** DELETE /api/tickets/menu-items/:id */
  static async deleteItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const item = await MenuItem.findById(req.params['id']);
      if (!item) { ApiResponseUtil.notFound(res, 'Menu item not found'); return; }
      const event = await loadOwnedEvent(req, res, String(item.eventId));
      if (!event) return;
      await item.deleteOne();
      ApiResponseUtil.success(res, { deleted: true });
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/menu-orders — organizer view of incoming preorders */
  static async listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const orders = await MenuOrder.find({ eventId: event._id }).sort({ createdAt: -1 }).limit(500);
      ApiResponseUtil.success(res, orders);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/menu-orders/:id — organizer updates the preparation status */
  static async updateOrderFulfillment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await MenuOrder.findById(req.params['id']);
      if (!order) { ApiResponseUtil.notFound(res, 'Order not found'); return; }
      const event = await loadOwnedEvent(req, res, String(order.eventId));
      if (!event) return;
      const { error, value } = updateMenuOrderFulfillmentSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const next = value.fulfillmentStatus as MenuOrderFulfillmentStatus;
      const refusal = fulfillmentTransitionRefusal(order, next);
      if (refusal) { ApiResponseUtil.error(res, refusal, 409); return; }
      order.fulfillmentStatus = next;
      await order.save();
      ApiResponseUtil.success(res, order);
    } catch (err) { next(err); }
  }

  /**
   * Vendor-scoped lookup by the human/QR-facing `orderId` (not the Mongo
   * _id) — what the gate/collection scanner reads off the buyer's QR code.
   * Returns 404 for both "no such order" and "belongs to another vendor" so
   * a scanner never learns whether an orderId format is merely wrong or
   * genuinely someone else's — same shape as a not-found.
   */
  private static async loadOrderByCode(req: Request, res: Response, orderId: string) {
    const order = await MenuOrder.findOne({ orderId });
    if (!order) { ApiResponseUtil.notFound(res, 'Order not found'); return null; }
    const actor = actorOf(req);
    if (!actor.isSuperAdmin && String(order.vendorId) !== actor.vendorId) {
      ApiResponseUtil.notFound(res, 'Order not found'); return null;
    }
    return order;
  }

  /** POST /api/tickets/menu-orders/scan — preview an order by its QR code, read-only. */
  static async lookupOrderByCode(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = scanMenuOrderSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const order = await MenuAdminController.loadOrderByCode(req, res, value.orderId);
      if (!order) return;
      ApiResponseUtil.success(res, order);
    } catch (err) { next(err); }
  }

  /**
   * POST /api/tickets/menu-orders/collect — the scanner's "confirm
   * collection" action.
   *
   * The actual transition is a single atomic `findOneAndUpdate` conditioned
   * on the fulfillmentStatus the read saw (mirrors
   * MenuOrderService.finalizeMomoOrder's atomic claim) — two operators
   * scanning the same QR at once must collect it exactly once, never both
   * succeed, and never crash on a `.save()` version conflict. When the
   * conditional update matches nothing, a fresh read distinguishes "someone
   * else just collected it" (409 with the real timestamp) from any other
   * concurrent change.
   */
  static async collectOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { error, value } = scanMenuOrderSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const order = await MenuAdminController.loadOrderByCode(req, res, value.orderId);
      if (!order) return;

      const alreadyCollectedMessage = (o: { collectedAt?: Date | null }) =>
        `Order already collected${o.collectedAt ? ` at ${o.collectedAt.toLocaleString()}` : ''}`;

      if (order.fulfillmentStatus === MenuOrderFulfillmentStatus.COLLECTED) {
        ApiResponseUtil.error(res, alreadyCollectedMessage(order), 409);
        return;
      }

      const refusal = fulfillmentTransitionRefusal(order, MenuOrderFulfillmentStatus.COLLECTED);
      if (refusal) { ApiResponseUtil.error(res, refusal, 409); return; }

      const collectedAt = new Date();
      const claimed = await MenuOrder.findOneAndUpdate(
        { _id: order._id, fulfillmentStatus: order.fulfillmentStatus },
        { $set: { fulfillmentStatus: MenuOrderFulfillmentStatus.COLLECTED, collectedAt } },
        { new: true },
      );

      if (!claimed) {
        // Lost the race — someone else's scan (or a status change) landed
        // first. Re-read to report the real, current state rather than a
        // generic conflict.
        const fresh = await MenuOrder.findById(order._id);
        if (fresh?.fulfillmentStatus === MenuOrderFulfillmentStatus.COLLECTED) {
          ApiResponseUtil.error(res, alreadyCollectedMessage(fresh), 409);
        } else {
          ApiResponseUtil.error(res, 'Order changed while collecting — please rescan', 409);
        }
        return;
      }

      ApiResponseUtil.success(res, claimed, 'Order collected');
    } catch (err) { next(err); }
  }
}
