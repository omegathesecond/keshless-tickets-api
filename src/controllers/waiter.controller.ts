import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WaiterToken } from '@interfaces/waiter.interface';
import { operatorMayActOnEvent } from '@services/operatorEventScope.service';
import { HEX24 } from '@utils/controllerHelpers.util';
import {
  TableService, TableLabelTakenError, TableShortfallError,
  TableAlreadySettledError, TableWalletNotFoundError,
  TableChangedDuringSettlementError, TableIdempotencyMismatchError,
} from '@services/table.service';
import { StockDeclinedError } from '@services/stock.service';
import { PosCatalogService } from '@services/posCatalog.service';
import { WalletDeclinedError } from '@services/merchant.service';

/**
 * Load the event this waiter is working and assert they may act on it. Every
 * table route goes through here, so the "is this my show, is it even cashless,
 * is it live, and am I still employed" question is answered in exactly one
 * place. Returns null having ALREADY answered the response.
 *
 * The lifecycle and assignment checks mirror loadCashlessEvent, message for
 * message. Both matter because the token cannot carry either answer: it is
 * minted for 7 days and verified with no database lookup, so an event that has
 * since been cancelled and a waiter who has since been fired both still
 * present a perfectly valid token. operatorMayActOnEvent re-reads the waiter's
 * row (see waiterScope) and is what makes Disable take effect on the handheld
 * already in their pocket rather than only at their next login.
 */
export async function loadWaiterEvent(req: Request, res: Response): Promise<any | null> {
  const waiter = (req as any).waiter as WaiterToken;
  if (!waiter.eventId) { ApiResponseUtil.forbidden(res, 'No event on this waiter'); return null; }
  // A malformed claim would throw a CastError out of findById, and Express 4
  // does not await these handlers — the rejection escapes, nothing answers,
  // and the request hangs. That is the one way this function can break its
  // always-respond contract, so the id is shape-checked before it is cast.
  if (!HEX24.test(String(waiter.eventId))) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const event = await Event.findById(waiter.eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  if (!event.cashless) { ApiResponseUtil.error(res, 'Event is not cashless', 400); return null; }
  if (event.status !== EventStatus.PUBLISHED) { ApiResponseUtil.error(res, 'Event is not published', 400); return null; }
  if (!(await operatorMayActOnEvent(req, String(event._id)))) {
    ApiResponseUtil.error(res, 'You are not assigned to this event', 403); return null;
  }
  return event;
}

export class WaiterController {
  /** GET /api/waiter/events — the one event this waiter works. */
  static async getEvents(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    return ApiResponseUtil.success(res, {
      events: [{
        id: String(event._id), name: event.name, venue: event.venue,
        eventDate: event.eventDate,
      }],
      // The LIVE set, re-derived from the row by authenticateWaiter — not the
      // claim the handheld's 7-day token carries. This is what lets the floor
      // screen show a Settle button the moment the organizer grants settling,
      // instead of waiting for the waiter to sign out and back in.
      permissions: waiter.permissions,
    });
  }

  /**
   * GET /api/waiter/products — every stall's products at this event in ONE
   * searchable grid.
   *
   * A waiter serves the floor, not a stall: a normal order spans stalls ("two
   * beers from the bar, a burger from the grill"), so the sheet never makes
   * them pick a stall first. Each tile therefore names the stall it comes
   * from, and a product carried by three stalls appears three times — that
   * choice is the waiter's, and merchantId is what the subsequent addItem
   * call needs.
   *
   * Gated on VIEW_EVENTS rather than MANAGE_TABLES: this is a read of the
   * catalogue, in the same class as GET /events, and no table moves.
   */
  static async getProducts(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    try {
      const products = await PosCatalogService.forEvent(String(event._id));
      return ApiResponseUtil.success(res, { products });
    } catch (e: any) {
      // Answered, not thrown: Express 4 does not await these handlers, so an
      // escaping rejection would hang the handheld mid-order rather than
      // showing it an error.
      return ApiResponseUtil.error(res, e?.message || 'Failed to load products', 500);
    }
  }

  /** POST /api/waiter/tables — open a new table under a number/label. */
  static async openTable(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) return ApiResponseUtil.badRequest(res, 'label is required');
    try {
      const table = await TableService.open({ eventId: String(event._id), label, openedBy: waiter.waiterId });
      return ApiResponseUtil.created(res, table);
    } catch (e) {
      // Two waiters opening "7" at once: the partial unique index arbitrates,
      // and the loser is told the table is taken, not given a 500.
      if (e instanceof TableLabelTakenError) return ApiResponseUtil.error(res, e.message, 409);
      throw e;
    }
  }

  /** GET /api/waiter/tables — tables at this waiter's event, optionally ?status=open|settled|voided. */
  static async listTables(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const tables = await TableService.list(String(event._id), status);
    return ApiResponseUtil.success(res, { tables });
  }

  /** POST /api/waiter/tables/:id/items — add an item from a stall, moving its stock. */
  static async addItem(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const { merchantId, productId, qty } = req.body || {};
    if (!merchantId || !productId) return ApiResponseUtil.badRequest(res, 'merchantId and productId are required');
    if (!Number.isInteger(qty) || qty <= 0) return ApiResponseUtil.badRequest(res, 'qty must be a positive whole number');
    try {
      const table = await TableService.addItem({
        tableId: req.params['id']!, eventId: String(event._id), merchantId, productId, qty, addedBy: waiter.waiterId,
      });
      return ApiResponseUtil.success(res, table);
    } catch (e) {
      // Out of stock at that stall — 409, distinct from a bad request: the
      // table/stall/product were all fine, the shelf just ran out.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Insufficient stock at that stall', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      const msg = (e as Error)?.message || 'Could not add item';
      // "stall is closed" (suspended) is a 400 alongside its neighbours here —
      // the request itself named a stall that cannot take new items right
      // now, same class of problem as "not sold at that stall"/"not found".
      const status = /not open/i.test(msg) ? 409
        : /not sold at that stall|not found|stall is closed/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /** DELETE /api/waiter/tables/:id/items/:lineId — remove a mis-punched line, returning its stock. */
  static async removeItem(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    try {
      const table = await TableService.removeItem({
        tableId: req.params['id']!, eventId: String(event._id), lineId: req.params['lineId']!, removedBy: waiter.waiterId,
      });
      return ApiResponseUtil.success(res, table);
    } catch (e) {
      const msg = (e as Error)?.message || 'Could not remove item';
      // "table not found"/"line not found on this table" are both 404s — the
      // URL named a resource that isn't there; "not open" is 409 — the
      // resource exists but the table has already moved past editable state.
      const status = /not open/i.test(msg) ? 409 : /not found/i.test(msg) ? 404 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /** POST /api/waiter/tables/:id/void — close an unpaid table, keeping the loss on record (stock is NOT returned). */
  static async voidTable(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    try {
      const table = await TableService.voidTable({
        tableId: req.params['id']!, eventId: String(event._id), reason, voidedBy: waiter.waiterId,
      });
      return ApiResponseUtil.success(res, table);
    } catch (e) {
      const msg = (e as Error)?.message || 'Could not void table';
      // "reason is required" is a 400 — the caller sent a bad request;
      // "not open"/"not found" mirror removeItem's split: the table exists
      // but has already moved past voidable state, or the id names nothing.
      const status = /reason is required/i.test(msg) ? 400 : /not open/i.test(msg) ? 409 : /not found/i.test(msg) ? 404 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /**
   * POST /api/waiter/tables/:id/settle — charge the whole tab to one tapped
   * tag, paying every stall on it at its own commission in one balanced
   * journal entry.
   *
   * Gated on SETTLE_TABLES, not MANAGE_TABLES: serving and taking money are
   * different jobs, and the money one is granted per person.
   *
   * settledBy/staffName come from the VERIFIED token, never the body — a
   * waiter must not be able to sign somebody else's name to a charge.
   */
  static async settleTable(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const bandUid = typeof req.body?.bandUid === 'string' ? req.body.bandUid.trim() : '';
    const clientTxnId = typeof req.body?.clientTxnId === 'string' ? req.body.clientTxnId.trim() : '';
    if (!bandUid) return ApiResponseUtil.badRequest(res, 'bandUid is required');
    // Required, not generated here: the id has to survive the retry that a
    // handheld makes after losing its network, so it must come from the
    // handheld. One generated server-side would be new on every attempt and
    // every retry would be a second bill.
    if (!clientTxnId) return ApiResponseUtil.badRequest(res, 'clientTxnId is required');

    try {
      const settlement = await TableService.settle({
        tableId: req.params['id']!, eventId: String(event._id), bandUid,
        settledBy: waiter.waiterId, staffName: waiter.fullName, clientTxnId,
      });
      return ApiResponseUtil.success(res, settlement);
    } catch (e) {
      // 402, with the shortfall in the payload so the handheld can tell the
      // guest what to add at the desk rather than just "declined".
      if (e instanceof TableShortfallError) {
        return ApiResponseUtil.error(res, e.message, 402, {
          reason: 'insufficient_balance', total: e.total, balance: e.balance, short: e.short,
        });
      }
      if (e instanceof WalletDeclinedError) {
        return ApiResponseUtil.error(res, e.message, 402, { reason: e.reason, balance: e.currentBalance });
      }
      // The tag names no wallet here — nothing to decline, so 404 not 402.
      if (e instanceof TableWalletNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      if (e instanceof TableAlreadySettledError) return ApiResponseUtil.error(res, e.message, 409);
      // Retryable, unlike the other 409s here: re-reading the tab and tapping
      // again is exactly the right thing for the waiter to do.
      if (e instanceof TableChangedDuringSettlementError) {
        return ApiResponseUtil.error(res, e.message, 409, { reason: 'table_changed', retryable: true });
      }
      if (e instanceof TableIdempotencyMismatchError) {
        return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason });
      }
      const msg = (e as Error)?.message || 'Could not settle table';
      const status = /nothing on this table/i.test(msg) ? 400
        : /not open/i.test(msg) ? 409
        : /not found/i.test(msg) ? 404 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }
}
