// api/src/controllers/merchant.controller.ts
import { Request, Response } from 'express';
import Joi from 'joi';
import mongoose from 'mongoose';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Merchant } from '@models/merchant.model';
import { Wallet } from '@models/wallet.model';
import { Product } from '@models/product.model';
import { MerchantService, WalletDeclinedError, ChargeIdempotencyMismatchError } from '@services/merchant.service';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { StockCountService } from '@services/stockCount.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockTransferService } from '@services/stockTransfer.service';
import { PosCatalogService } from '@services/posCatalog.service';
import { normalizeBandUid } from '@utils/bandUid.util';
import { chargeSchema } from '@validators/merchant.validator';
import { posCountSchema, posStockAdjustSchema, posTransferSchema } from '@validators/stock.validator';
import { toBaseUnits } from '@utils/stockUnits.util';
import { StockMovementReason } from '@interfaces/stock.interface';
import {
  TableService, TableFulfilmentNotFoundError, TableFulfilmentStateError,
} from '@services/table.service';
import { TableFulfilmentStatus } from '@interfaces/table.interface';
import { HEX24 } from '@utils/controllerHelpers.util';

/** The statuses a stall may filter its table feed by — see MerchantController.tables. */
const FULFILMENT_STATUSES: TableFulfilmentStatus[] = ['paid', 'handed_out', 'collected'];
import { MerchantToken } from '@interfaces/merchant.interface';

/** Human-facing message per WalletDeclinedError reason, for the 402 envelope. */
const DECLINE_MESSAGE: Record<WalletDeclinedError['reason'], string> = {
  insufficient_balance: 'Insufficient balance',
  wallet_not_active: 'Wallet is not active',
  wallet_not_found: 'Wallet not found',
};

export class MerchantController {
  /**
   * POST /api/merchant/charge — tap-to-pay: debit the tapped band's wallet
   * and credit this merchant + the platform fee (cashless spec).
   * merchantId/eventId come ONLY from the verified merchant JWT
   * (authenticateMerchant), never the request body, so a merchant can never
   * charge as another merchant or against a different event.
   */
  static async charge(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = chargeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const merchant = (req as any).merchant as MerchantToken;
      const { merchantId, eventId, merchantOperatorId, operatorName } = merchant;

      const event = await Event.findById(eventId).lean();
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);
      // Lifecycle guard, mirroring ResellerController.cashTopup: a merchant
      // token must not be able to drain wallets at a cancelled or
      // not-yet-live event.
      if (event.status !== EventStatus.PUBLISHED) {
        return ApiResponseUtil.error(res, 'Event is not published', 400);
      }

      const bandUid = normalizeBandUid(value.bandUid);
      const wallet = await Wallet.findOne({ eventId, bandUid });
      if (!wallet) return ApiResponseUtil.notFound(res, 'No wallet for that band');

      const result = await MerchantService.charge({
        merchantId, eventId, walletId: String(wallet._id), bandUid,
        clientTxnId: value.clientTxnId,
        ...(value.amount != null ? { amount: value.amount } : {}),
        ...(value.items ? { items: value.items } : {}),
        // The PERSON who rang this up comes ONLY from the verified JWT. A
        // client-supplied staffName is stripped at chargeSchema (Joi.any().strip())
        // before `value` even exists here — nothing to read, let alone forward.
        merchantOperatorId, operatorName,
      });

      if (result.charge.items?.length) {
        // Best-effort, off the money path: a notification failure logs loudly but never affects the sale.
        StockAlertService.evaluateAfterSale({
          eventId, merchantId, vendorId: String(event.vendorId),
          productIds: result.charge.items.map((i) => String(i.productId)),
        }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
      }

      return ApiResponseUtil.success(res, {
        newBalance: result.wallet.balance,
        amount: result.charge.amount,
        fee: result.charge.fee,
        merchantNet: result.charge.netAmount,
        ...(result.charge.items ? { items: result.charge.items } : {}),
      });
    } catch (e: any) {
      // DECLINE: an item line's stock couldn't cover the sale — 409, distinct
      // from the 402 wallet decline below, so a POS client can tell "the
      // customer's card is fine, we're out of this product" apart from "the
      // customer can't pay." Checked before WalletDeclinedError only for
      // readability — the two error classes never overlap on one throw.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, `Out of stock`, 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      // DECLINE: insufficient balance / inactive wallet — 402, never 4xx/5xx,
      // so a POS client can distinguish "try a different card/band" from a
      // genuine request error. Goes through the standard ApiResponseUtil
      // envelope (success:false, message, error) like every other endpoint —
      // reason + currentBalance ride in the `error` payload, the same way
      // tickets.controller.ts's checkInTicket/reissueBand pass a structured
      // result object as ApiResponseUtil.error's 4th argument.
      if (e instanceof WalletDeclinedError) {
        return ApiResponseUtil.error(res, DECLINE_MESSAGE[e.reason], 402, {
          reason: e.reason,
          currentBalance: e.currentBalance,
        });
      }
      // A clientTxnId reused for a DIFFERENT sale — 409, never the original
      // success: the till must mint a new id rather than be told "paid".
      if (e instanceof ChargeIdempotencyMismatchError) {
        return ApiResponseUtil.error(res, 'clientTxnId already used for a different charge', 409, {
          reason: e.reason, clientTxnId: e.clientTxnId,
        });
      }
      const msg = e?.message || 'Charge failed';
      const status = /not found|cashless|amount|not active|exactly one|products? not found|positive integer/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /**
   * GET /api/merchant/transactions — this merchant's takings: a recent-first
   * page of their charges plus a summary over ALL of them. merchantId comes
   * ONLY from the verified merchant JWT (authenticateMerchant), never a query
   * param, so a merchant can never see another merchant's charges.
   */
  static async listTransactions(req: Request, res: Response): Promise<any> {
    try {
      const merchant = (req as any).merchant as MerchantToken;
      const { merchantId } = merchant;

      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;

      const result = await MerchantService.listTransactions({ merchantId, limit });
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load transactions', 500);
    }
  }

  /** GET /api/merchant/stock — this bar's products + onHand for the stock-take screen. */
  static async stock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      // Through PosCatalogService so this grid and the waiter's event-wide one
      // answer "which stall carries this product" the same way — one stock row
      // per stall-product, exactly what StockService.applyMovement's CAS and
      // TableService.addItem enforce on the write side.
      const stock = await PosCatalogService.forMerchant(merchantId, eventId);
      return ApiResponseUtil.success(res, { stock });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Failed to load stock', 500); }
  }

  /**
   * GET /api/merchant/tables — the tables THIS stall owes stock to.
   *
   * The counter-side view of a waiter's tab: the guest has already paid (rows
   * exist only once a table is settled), and this screen is where the bar or
   * kitchen sees what to hand over and to whom.
   *
   * Scoped to the caller's own stall by TableService.listForStall, which also
   * strips every other stall's lines and reprices the subtotal from what is
   * left — a stall must never read what another poured, nor what the guest
   * paid across the whole tab.
   */
  static async tables(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const raw = req.query['status'];
      // Whitelisted, not passed through: an unknown value must not silently
      // widen the query into "every status" on a screen whose whole job is
      // telling paid-for stock apart from stock already handed over.
      const status = FULFILMENT_STATUSES.find((s) => s === raw);
      const tables = await TableService.listForStall({ eventId, merchantId, status });
      return ApiResponseUtil.success(res, { tables });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load tables', 500);
    }
  }

  /**
   * POST /api/merchant/tables/:id/hand-out — this stall's half of the
   * handshake: the stock has left the counter.
   *
   * Attributed to the PERSON on the till, not the stall, for the same reason
   * a charge is: "the bar handed it over" names nobody when a handover is
   * later disputed.
   */
  static async handOutTable(req: Request, res: Response): Promise<any> {
    const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
    const tableId = String(req.params['id']);
    // Shape-checked before the cast: an unguarded ObjectId cast throws a
    // CastError out of a handler Express 4 does not await, hanging the request.
    if (!HEX24.test(tableId)) {
      return ApiResponseUtil.notFound(res, 'no handover for this stall on that table');
    }
    try {
      const table = await TableService.handOut({
        tableId, eventId, merchantId, handedOutBy: merchantOperatorId,
      });
      const [view] = await TableService.listForStall({ eventId, merchantId });
      // The redacted view, never the whole table: the raw document carries
      // every other stall's lines.
      return ApiResponseUtil.success(res, view ?? { _id: String(table._id), label: table.label });
    } catch (e) {
      if (e instanceof TableFulfilmentNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      if (e instanceof TableFulfilmentStateError) return ApiResponseUtil.error(res, e.message, 409);
      throw e;
    }
  }

  /**
   * GET /api/merchant/stalls — transfer destinations: the OTHER live stalls at
   * this event. The caller's own stall is excluded because a transfer to
   * yourself is rejected downstream; offering it would be a dead option.
   */
  static async stalls(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const rows = await Merchant.find({ eventId, status: 'active' }).select('name').sort({ name: 1 }).lean();
      const stalls = rows
        .filter((m: any) => String(m._id) !== String(merchantId))
        .map((m: any) => ({ merchantId: String(m._id), name: m.name }));
      return ApiResponseUtil.success(res, { stalls });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Could not load stalls', 500);
    }
  }

  /** POST /api/merchant/stock/count — a stock-take by this bar (merchantId from JWT). */
  static async recordCount(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const { error, value } = posCountSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(eventId)) return ApiResponseUtil.badRequest(res, 'product does not belong to this event');
      const { count, onHand } = await StockCountService.recordCount({ eventId, merchantId, productId: value.productId, countedOnHand: value.countedOnHand, phase: value.phase, byType: 'Merchant', by: merchantOperatorId });
      return ApiResponseUtil.success(res, { countId: String(count._id), expectedOnHand: count.expectedOnHand, countedOnHand: count.countedOnHand, variance: count.variance, onHand });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Count failed', 500); }
  }

  /**
   * Resolve the product named in the body against the token's event and turn
   * the quantity into base units. Returns null after answering the response —
   * every POS stock write shares these two refusals.
   */
  private static async resolveProductAndUnits(
    req: Request, res: Response, value: { productId: string; quantity: number; unit: 'unit' | 'pack' },
  ): Promise<number | null> {
    const { eventId } = (req as any).merchant as MerchantToken;
    const product = await Product.findById(value.productId).lean();
    if (!product || String(product.eventId) !== String(eventId)) {
      ApiResponseUtil.badRequest(res, 'product does not belong to this event');
      return null;
    }
    const units = toBaseUnits(product, value.quantity, value.unit);
    if (units == null) {
      ApiResponseUtil.badRequest(res, 'product has no pack size; receive in units');
      return null;
    }
    return units;
  }

  /**
   * Shared POS stock-write preamble: validate the body against `schema`, then
   * resolve the named product + convert its quantity to base units. Returns
   * null after already answering the response (either step can refuse).
   * Every stock write (receive/waste/transfer) starts here; anything past
   * this point is specific to what the write does.
   */
  private static async validateStockWrite<T extends { productId: string; quantity: number; unit: 'unit' | 'pack' }>(
    req: Request, res: Response, schema: Joi.ObjectSchema<T>,
  ): Promise<{ value: T; units: number } | null> {
    const { error, value } = schema.validate(req.body);
    if (error) { ApiResponseUtil.error(res, error.message, 400); return null; }
    const units = await MerchantController.resolveProductAndUnits(req, res, value);
    if (units == null) return null;
    return { value, units };
  }

  /** POST /api/merchant/stock/receive — a delivery INTO this stall. */
  static async receiveStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const resolved = await MerchantController.validateStockWrite(req, res, posStockAdjustSchema);
      if (resolved == null) return;
      const { value, units } = resolved;

      const { onHand, movement } = await StockService.applyMovement({
        eventId, merchantId, productId: value.productId,
        delta: units, reason: StockMovementReason.RECEIVE,
        refType: 'stock_receive', refId: String(new mongoose.Types.ObjectId()),
        byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      // Fire-and-forget: a receive back above threshold re-arms the alert. A
      // rearm failure must never turn a successful receive into a 500.
      StockAlertService.rearm(String(merchantId), String(value.productId)).catch(() => {});
      return ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Receive failed', 500);
    }
  }

  /** POST /api/merchant/stock/waste — breakage and spoilage at this stall. */
  static async wasteStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const resolved = await MerchantController.validateStockWrite(req, res, posStockAdjustSchema);
      if (resolved == null) return;
      const { value, units } = resolved;

      const { onHand, movement } = await StockService.applyMovement({
        eventId, merchantId, productId: value.productId,
        delta: -units, reason: StockMovementReason.SPOILAGE,
        refType: 'stock_waste', refId: String(new mongoose.Types.ObjectId()),
        byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      return ApiResponseUtil.success(res, { onHand, movementId: String(movement._id) });
    } catch (e: any) {
      // The CAS guard in applyMovement declined the decrement: the stall does
      // not hold that much. Same envelope the charge path returns, so a POS
      // client has one shape to handle.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Not enough on hand', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      return ApiResponseUtil.error(res, e?.message || 'Write-off failed', 500);
    }
  }

  /** POST /api/merchant/stock/transfer — move stock from THIS stall to another. */
  static async transferStock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId, merchantOperatorId } = (req as any).merchant as MerchantToken;
      const resolved = await MerchantController.validateStockWrite(req, res, posTransferSchema);
      if (resolved == null) return;
      const { value, units } = resolved;

      if (String(value.toMerchantId) === String(merchantId)) {
        return ApiResponseUtil.badRequest(res, 'cannot transfer to the same stall');
      }

      // The destination must be a live stall at THIS event. Without this check
      // a valid id from another event would move stock across event
      // boundaries, which no report would ever reconcile.
      const destination = await Merchant.findById(value.toMerchantId).lean();
      if (!destination || String(destination.eventId) !== String(eventId) || destination.status !== 'active') {
        return ApiResponseUtil.badRequest(res, 'destination stall is not an active stall at this event');
      }

      const { transfer, fromOnHand, toOnHand } = await StockTransferService.transfer({
        eventId, productId: value.productId,
        fromMerchantId: String(merchantId), toMerchantId: String(value.toMerchantId),
        qty: units, byType: 'Merchant', by: merchantOperatorId, note: value.note,
      });
      return ApiResponseUtil.success(res, {
        transferId: String(transfer._id), fromOnHand, toOnHand,
      });
    } catch (e: any) {
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Not enough on hand', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      return ApiResponseUtil.error(res, e?.message || 'Transfer failed', 500);
    }
  }
}
