import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';
import { Event } from '@models/event.model';
import { ITicket, ITicketSale, TicketStatus, PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { EventStatus, type ITicketType } from '@interfaces/event.interface';
import { resolveCart, assertSingleAttribution } from '@services/cart.service';
import type { CartLine } from '@interfaces/cart.interface';
import { EventService } from '@services/event.service';
import { getProcessor } from '@services/payments';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { normalizePhone } from '@utils/phone.util';
import { buyerTicketOr } from '@utils/ticketHolder.util';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { PeachClient, classifyResultCode } from '@services/payments/peach.client';
import { DeltapayClient, classifySessionStatus } from '@services/payments/deltapay.client';
import { YocoClient, classifyEventType, toCents } from '@services/payments/yoco.client';
import {
  YeboPayClient,
  classifyEventType as classifyYeboPayEventType,
  classifyCheckoutStatus,
} from '@services/payments/yebopay.client';
import { ReservationService } from '@services/reservation.service';
import { TicketReservation } from '@models/ticketReservation.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { computeServiceFee, round2 } from '@utils/serviceFee.util';
import { resolveSaleResellerId } from '@utils/allocationAttribution.util';
import { computeSaleEconomics, SaleEconomics, SaleSoldByType } from '@services/saleEconomics.service';
import { assertCarrotTicketing } from '@utils/ticketingGuard.util';
import { FollowService } from '@services/follow.service';
import { EventCurrency, settlementCurrencyForMethod } from '@utils/currency.util';
import mongoose from 'mongoose';

export interface SellTicketsParams {
  eventId: string;
  vendorId: string;
  /**
   * One entry per tier in this sale. A single-tier sale is a one-element
   * array — the shape every caller sent implicitly before multi-tier
   * checkout.
   *
   * Deliberately just {ticketTypeId, quantity}, NOT the resolved tier: this
   * function already re-reads every tier through checkTicketAvailability (it
   * is the choke point, so it cannot take a caller's word for stock), and
   * that call hands back the tier. Asking callers for the snapshot too would
   * make each of them load the event for data we fetch anyway, and let a
   * stale snapshot disagree with the tier we actually validated.
   */
  lines: Array<{ ticketTypeId: string; quantity: number }>;
  customerName?: string;
  customerPhone?: string;
  // Buyer identity (buyer-authed purchase paths only — VENDOR/POS sales
  // leave these unset, since there's no logged-in buyer to stamp).
  customerEmail?: string;
  buyerId?: string;
  paymentMethod: PaymentMethod;
  keshlessCardNumber?: string;
  keshlessPin?: string;
  soldBy: string;
  soldByType: 'vendor' | 'sub-user' | 'reseller-operator';
  // Reseller flow (Task 8 supplies these); vendor sales leave them unset.
  resellerId?: string;
  hubId?: string;
  resellerCommissionPercent?: number;
  // "Where bought". Defaults via deriveChannel(); the online buyer flow passes
  // SalesChannel.ONLINE explicitly since soldByType alone can't distinguish it.
  channel?: SalesChannel;
  // Buyer-paid FLAT service fee (online checkout only). When set, the wallet is
  // debited totalAmount + serviceFeeAmount, and the fee is recorded on the sale.
  // POS/reseller callers omit it, so face value is charged unchanged.
  serviceFeeAmount?: number;
  // Booking fee the ORGANIZER covers (events flagged organizerAbsorbsServiceFee).
  // Mutually exclusive with serviceFeeAmount: the buyer is charged face, and
  // this is netted out of organizerProceeds instead.
  absorbedServiceFeeAmount?: number;
}

/**
 * Maps the params `soldByType` union onto the persisted refPath enum value used
 * by the TicketSale `soldBy` polymorphic ref. Single source of truth so the
 * three sale-build sites can never drift.
 */
const SOLD_BY_TYPE_MAP: Record<SellTicketsParams['soldByType'], SaleSoldByType> = {
  vendor: 'Vendor',
  'sub-user': 'VendorSubUser',
  'reseller-operator': 'ResellerOperator',
};

/**
 * Derives the default sales channel from the persisted soldByType. Reseller
 * operator sales are reseller_pos; everything else defaults to box_office.
 * The online buyer flows override this by passing channel explicitly.
 */
export function deriveChannel(mappedSoldByType: SaleSoldByType): SalesChannel {
  return mappedSoldByType === 'ResellerOperator'
    ? SalesChannel.RESELLER_POS
    : SalesChannel.BOX_OFFICE;
}

export interface GetSalesQuery {
  vendorId: string;
  eventId?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  channel?: SalesChannel;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
}

/**
 * Mongoose `populate('eventId', ...)` overwrites the `eventId` field with the
 * full event document. The dashboard, however, expects a string `eventId` plus
 * a separate populated `event` object. This reshapes a lean record to match —
 * surfacing the event name (so "Event: N/A" stops appearing) while keeping
 * `eventId` a usable id.
 */
function withEvent<T extends { eventId?: any }>(record: T): T & { event?: any } {
  const populated = record.eventId;
  if (populated && typeof populated === 'object' && populated._id) {
    return { ...record, event: populated, eventId: populated._id };
  }
  return record;
}

export class TicketService {
  /**
   * Single canonical factory for building a Ticket document.
   * All three minting sites (sellTickets main loop, sellTickets no-tx fallback,
   * finalizeMomoSale) call this so field lists can never drift between paths.
   * saleId is omitted when not supplied — sellTickets sets it later via updateMany.
   */
  private static buildTicket(p: {
    eventId: any;
    vendorId: any;
    ticketType: string;
    price: number;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    buyerId?: any;
    saleId?: any;
    currency?: EventCurrency;
  }) {
    return new Ticket({
      eventId: p.eventId,
      vendorId: p.vendorId,
      ticketType: p.ticketType,
      price: p.price,
      customerName: p.customerName,
      // Store the phone in the SAME normalized form findTicketsByCustomerPhone
      // looks tickets up by — otherwise a POS sale typed as "78422613" never
      // matches a "My Tickets" login that normalizes to "+26878422613".
      customerPhone: p.customerPhone ? normalizePhone(p.customerPhone) : p.customerPhone,
      status: TicketStatus.SOLD,
      currency: p.currency ?? 'SZL',
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      ...(p.saleId ? { saleId: p.saleId } : {}),
    });
  }

  /**
   * Single canonical builder for the immutable economic snapshot persisted on
   * EVERY TicketSale. Resolves the live platformFeePercent from PaymentConfig,
   * runs computeSaleEconomics (which owns all money rounding), and returns the
   * snapshot fields to spread onto `new TicketSale({...})`. All sale-build sites
   * (vendor main, vendor no-tx fallback, buyer/MoMo) call this so the ledger can
   * never see a snapshot-less sale.
   */
  private static async buildSaleSnapshot(p: {
    totalAmount: number;
    paymentMethod: PaymentMethod;
    mappedSoldByType: SaleSoldByType;
    resellerCommissionPercent?: number;
    displayCurrency: EventCurrency;
    /** Booking fee the organizer covers on this sale (absorbing events only). */
    absorbedServiceFeeAmount?: number;
  }): Promise<SaleEconomics & { currency: EventCurrency; settlementCurrency: EventCurrency }> {
    const cfg = await PaymentConfigService.get();
    return {
      ...computeSaleEconomics({
        faceAmount: p.totalAmount,
        paymentMethod: p.paymentMethod,
        soldByType: p.mappedSoldByType,
        resellerCommissionPercent: p.resellerCommissionPercent ?? 0,
        platformFeePercent: cfg.platformFeePercent,
        absorbedServiceFeeAmount: p.absorbedServiceFeeAmount ?? 0,
      }),
      currency: p.displayCurrency,
      settlementCurrency: settlementCurrencyForMethod(p.paymentMethod),
    };
  }

  /**
   * A completed ticket sale auto-follows its organizer for the buyer — the
   * same buyer→organizer edge a manual "Follow" creates. Delegates to
   * FollowService.autoFollowOrganizer, which is best-effort (never throws into
   * the sale path), registered-buyers-only (no-op without buyerId, e.g. guest /
   * POS walk-up checkout), and organizer-aware (no-op without vendorId, e.g.
   * self-listed community events). Gated on COMPLETED so a PENDING online sale
   * follows only once its finalize* mints it — not while awaiting payment.
   */
  private static async autoFollowOrganizerForSale(sale: ITicketSale): Promise<void> {
    if (sale.paymentStatus !== PaymentStatus.COMPLETED) return;
    await FollowService.autoFollowOrganizer(
      sale.buyerId ? String(sale.buyerId) : undefined,
      sale.vendorId ? String(sale.vendorId) : undefined
    );
  }

  /**
   * Helper to start a transaction session safely
   * Returns null if transactions are not supported (standalone MongoDB)
   */
  private static async startSessionSafely(): Promise<mongoose.ClientSession | null> {
    try {
      const session = await mongoose.startSession();
      session.startTransaction();
      return session;
    } catch (error: any) {
      // Check if error is due to MongoDB not being in replica set mode
      if (error.message?.includes('Transaction numbers are only allowed on a replica set') ||
          error.message?.includes('transactions are not supported')) {
        console.warn('⚠️  MongoDB transactions not supported (standalone mode). Running without transactions.');
        return null;
      }
      throw error;
    }
  }

  /**
   * Helper to execute database operation with optional session
   * Catches transaction errors and retries without session
   */
  private static async executeWithOptionalSession<T>(
    operation: (session?: mongoose.ClientSession) => Promise<T>,
    session: mongoose.ClientSession | null
  ): Promise<T> {
    try {
      return await operation(session || undefined);
    } catch (error: any) {
      // If transaction error and we have a session, retry without it
      if (session && (
        error.message?.includes('Transaction numbers are only allowed on a replica set') ||
        error.message?.includes('transactions are not supported')
      )) {
        console.warn('⚠️  MongoDB transactions not supported. Retrying without transaction.');
        await session.abortTransaction();
        session.endSession();
        return await operation(undefined);
      }
      throw error;
    }
  }

  /**
   * Sell tickets (both cash and wallet payment)
   */

  /**
   * Mints an async rail's tickets once its payment has settled, from the
   * composition snapshotted on the sale at checkout.
   *
   * The five async rails create a PENDING sale and mint later, from a
   * webhook. Before `TicketSale.lines` existed they each reconstructed the
   * order as `sale.quantity` tickets of ONE tier priced
   * `sale.totalAmount / sale.quantity` — an AVERAGE, correct only when every
   * ticket in the sale costs the same. On a mixed cart that mints the wrong
   * tier at the wrong price and moves the wrong tier's inventory.
   *
   * A settled sale with no `lines` is an invariant violation, not a case to
   * paper over: it means the sale was written by a build that predates this
   * field and should have been resolved by the pre-deploy drain. It throws
   * rather than minting a guess — silently minting the wrong ticket for real
   * money is far worse than a loud failure an operator can act on.
   */
  private static async mintSettledSaleTickets(sale: ITicketSale): Promise<ITicket[]> {
    const lines = sale.lines;
    if (!lines || lines.length === 0) {
      throw new Error(
        `Sale ${String(sale._id)} settled with no line composition — refusing to mint. ` +
        `This sale predates TicketSale.lines and should have been resolved by ` +
        `src/scripts/releaseHeldReservations.ts before deploy.`
      );
    }

    const tickets: ITicket[] = [];
    for (const line of lines) {
      for (let i = 0; i < line.quantity; i++) {
        const t = this.buildTicket({
          eventId: sale.eventId,
          vendorId: sale.vendorId,
          ticketType: line.ticketTypeName,
          price: line.unitPrice,
          customerName: sale.customerName,
          customerPhone: sale.customerPhone,
          customerEmail: sale.customerEmail,
          buyerId: sale.buyerId,
          saleId: sale._id,
          // The sale already carries the currency stamped at initiate time
          // (buildSaleSnapshot) — reuse it rather than re-deriving from event.
          currency: sale.currency ?? 'SZL',
        });
        await t.save();
        tickets.push(t);
      }
    }
    return tickets;
  }

  /**
   * Moves each tier's own sold counter for a settled async sale. Called once
   * per line, so a mixed cart cannot credit every seat to one tier.
   */
  private static async applySoldCountsForSale(sale: ITicketSale): Promise<void> {
    for (const line of sale.lines ?? []) {
      await EventService.updateTicketsSold(
        sale.eventId.toString(),
        line.ticketTypeId,
        line.quantity,
        round2(line.unitPrice * line.quantity)
      );
    }
  }

  /**
   * Fulfils an async-rail sale that has just been atomically claimed COMPLETED,
   * and releases the claim again if that fulfilment fails.
   *
   * The claim has to be taken BEFORE the tickets exist — it is the only thing
   * standing between a concurrent poll, callback and reconcile all minting the
   * same sale. The cost is that the claim can outlive a failed fulfilment, and
   * because every finalizer early-returns on a non-PENDING sale, the result is
   * a sale marked COMPLETED with no tickets that can never be retried: the
   * buyer has paid and the system believes it delivered. That is exactly how
   * the 2026-09-08 MoMo debit ended up stranded.
   *
   * On failure we therefore ask the only question that decides it — did
   * anything actually get minted?
   *
   * - NOTHING minted → release the claim back to PENDING so the next
   *   poll/callback/reconcile can legitimately retry once the cause is fixed.
   * - SOMETHING minted → the claim STAYS. Reverting would let a retry mint a
   *   SECOND set of tickets against a single payment, which is worse than the
   *   stall; it is logged loudly for manual repair instead.
   *
   * Either way the original error propagates — a caller must never report
   * success for a sale it did not fulfil.
   */
  private static async fulfilClaimedSale(
    sale: ITicketSale,
    claimed: ITicketSale
  ): Promise<ITicket[]> {
    try {
      const tickets: ITicket[] = await this.mintSettledSaleTickets(sale);

      claimed.ticketIds = tickets.map(t => t._id as mongoose.Types.ObjectId);
      await claimed.save();

      await ReservationService.confirm(sale._id.toString()); // reserved -= qty
      await this.applySoldCountsForSale(sale); // sold += qty, per line

      return tickets;
    } catch (err) {
      const minted = await Ticket.countDocuments({ saleId: sale._id });
      const detail = {
        saleId: sale._id.toString(),
        saleRef: sale.saleId,
        paymentMethod: sale.paymentMethod,
        error: err instanceof Error ? err.message : String(err),
      };

      if (minted === 0) {
        await TicketSale.updateOne(
          {
            _id: sale._id,
            paymentStatus: PaymentStatus.COMPLETED,
            $or: [{ ticketIds: { $size: 0 } }, { ticketIds: { $exists: false } }],
          },
          { $set: { paymentStatus: PaymentStatus.PENDING } }
        );
        console.error(
          '[finalize] ✗ fulfilment failed with NOTHING minted — claim released back to PENDING for retry',
          detail
        );
      } else {
        console.error(
          '[finalize] ✗✗ fulfilment failed AFTER minting — sale LEFT COMPLETED, NEEDS MANUAL REPAIR',
          { ...detail, mintedTickets: minted }
        );
      }

      throw err;
    }
  }

  static async sellTickets(params: SellTicketsParams): Promise<{
    sale: ITicketSale;
    tickets: ITicket[];
    paymentMessage?: string;
  }> {
    const session = await this.startSessionSafely();

    try {
      const {
        eventId,
        vendorId,
        lines,
        customerName,
        customerEmail,
        buyerId,
        paymentMethod,
        keshlessCardNumber,
        keshlessPin,
        soldBy,
        soldByType
      } = params;

      // Normalize once so the sale record + confirmation SMS use the same
      // canonical phone form the tickets are stored under (mirrors
      // purchaseForCustomer). Prevents POS "78422613" vs login "+26878422613".
      const customerPhone = params.customerPhone
        ? normalizePhone(params.customerPhone)
        : params.customerPhone;

      // Guard: Carrot never processes a sale for an externally-sold event.
      // This is the SINGLE mint choke point every sale path funnels through —
      // purchaseForCustomer already guards at its own entry point (harmless
      // double-check here), but the POS "sell tickets" controller and the
      // reseller cash/keshless_wallet lanes call sellTickets directly with no
      // event in scope, so this is the ONLY place those paths get checked.
      // A missing event is left for checkTicketAvailability below to report —
      // guarding only when the event is found keeps this a no-op for that case.
      const eventForGuard = await Event.findById(eventId).select('ticketing currency');
      if (eventForGuard) assertCarrotTicketing(eventForGuard);
      // Legacy-doc default only — every current event carries `currency`.
      const displayCurrency: EventCurrency = eventForGuard?.currency ?? 'SZL';

      const quantity = lines.reduce((sum, l) => sum + l.quantity, 0);

      // Availability is re-checked per line even though resolveCart already
      // did it: this is the choke point EVERY path funnels through, including
      // the POS and reseller callers that never go near resolveCart.
      //
      // Note this checks each line against its own quantity. That is the right
      // per-tier stock question, but it makes checkTicketAvailability's
      // per-account cap check per-line here too, which is weaker than the rule.
      // That is not a hole: multi-line carts only ever arrive via resolveCart,
      // which enforces the cap against the cart TOTAL before we get here, and
      // the direct callers (POS, reseller) are single-line, where the two are
      // the same number.
      const resolvedLines: Array<{ ticketTypeId: string; ticketType: ITicketType; quantity: number }> = [];
      for (const line of lines) {
        const availabilityCheck = await EventService.checkTicketAvailability(
          eventId,
          line.ticketTypeId,
          line.quantity,
          paymentMethod,
          { buyerId: params.buyerId, phone: params.customerPhone }
        );
        if (!availabilityCheck.available) {
          throw new Error(availabilityCheck.message || 'Tickets not available');
        }
        resolvedLines.push({
          ticketTypeId: line.ticketTypeId,
          ticketType: availabilityCheck.ticketTypeData!,
          quantity: line.quantity,
        });
      }

      const totalAmount = round2(
        resolvedLines.reduce((sum, l) => sum + l.ticketType.price * l.quantity, 0)
      );

      // Composition snapshot persisted on the sale — see ticketSale.model's
      // `lines`. sellTickets mints immediately so it does not need this
      // itself, but every sale carrying it keeps reporting and refunds
      // uniform across the sync and async rails.
      const saleLines = resolvedLines.map((l) => ({
        ticketTypeId: l.ticketTypeId,
        ticketTypeName: l.ticketType.name,
        unitPrice: l.ticketType.price,
        quantity: l.quantity,
      }));

      // Buyer-paid service fee (online only — callers that omit it charge face).
      // totalAmount stays face value; the wallet is debited amountCharged.
      const serviceFeeAmount = round2(params.serviceFeeAmount ?? 0);
      const amountCharged = round2(totalAmount + serviceFeeAmount);
      const feeSnapshot = { serviceFeeAmount, amountCharged };
      const absorbedServiceFeeAmount = round2(params.absorbedServiceFeeAmount ?? 0);

      // Process payment based on method
      const proc = getProcessor(paymentMethod);
      const charge = await proc.charge({
        method: paymentMethod,
        amount: amountCharged,
        description: resolvedLines.length === 1
          ? `Carrot Tickets - ${resolvedLines[0]!.ticketType.name} x${resolvedLines[0]!.quantity}`
          : `Carrot Tickets - ${quantity} tickets (${resolvedLines.length} types)`,
        keshlessCardNumber,
        keshlessPin,
      });
      if (charge.status === 'failed') {
        throw new Error(charge.message);
      }
      // Explicit status mapping — NEVER let a non-completed charge fall through
      // to COMPLETED. A 'pending' charge (uncollected money) must persist as a
      // PENDING sale so the organizer-payout/reseller ledgers (which count only
      // `completed`) cannot credit the organizer for money not yet collected.
      // Mirrors initiateMomoPurchase's PENDING semantics: no funds confirmed yet.
      let paymentStatus: PaymentStatus;
      if (charge.status === 'completed') {
        paymentStatus = PaymentStatus.COMPLETED;
      } else if (charge.status === 'pending') {
        paymentStatus = PaymentStatus.PENDING;
      } else {
        // Defensive: any unexpected status is treated as a failure, never completed.
        throw new Error(charge.message || `Unexpected charge status: ${charge.status}`);
      }
      let walletTransactionId = charge.providerRef;
      let paymentMessage = charge.message;

      // Immutable economic snapshot — computed once, persisted on the sale in
      // BOTH the main and no-transaction-fallback branches. Without it the sale
      // would be invisible to the organizer-payout + reseller ledgers.
      const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
      const channel = params.channel ?? deriveChannel(mappedSoldByType);
      const econ = await this.buildSaleSnapshot({
        totalAmount,
        paymentMethod,
        mappedSoldByType,
        resellerCommissionPercent: params.resellerCommissionPercent,
        displayCurrency,
        absorbedServiceFeeAmount,
      });
      // Allocation tiers are attributed to the tier's owning reseller regardless
      // of who rang the sale (same rule as the online buyer paths). Taken from
      // the FIRST line: resolveCart guarantees every line in a cart shares one
      // attribution, rejecting carts that would span two owners.
      // Guarded HERE, not only in resolveCart: this is the choke point every
      // path funnels through, and the POS and reseller lanes reach it without
      // going near resolveCart. Without this a till could ring up two
      // resellers' allocation blocks in one sale and silently attribute both
      // to whichever happened to be line 0 — real money on the wrong ledger.
      assertSingleAttribution(resolvedLines);
      const attributionTier = resolvedLines[0]!.ticketType;
      const saleResellerId = resolveSaleResellerId(attributionTier, params.resellerId ? String(params.resellerId) : undefined);
      const resellerAttribution = {
        ...(saleResellerId ? { resellerId: saleResellerId } : {}),
        ...(params.hubId ? { hubId: params.hubId } : {}),
        ...(attributionTier.isAllocation ? { isAllocation: true } : {}),
      };

      // Create tickets — one inner pass per cart line, so every ticket carries
      // ITS OWN tier's name and price.
      const tickets: ITicket[] = [];
      const flattened = resolvedLines.flatMap((line) =>
        Array.from({ length: line.quantity }, () => line.ticketType)
      );
      for (const tier of flattened) {
        const ticket = this.buildTicket({
          eventId,
          vendorId,
          ticketType: tier.name,
          price: tier.price,
          customerName,
          customerPhone,
          customerEmail,
          buyerId,
          currency: displayCurrency,
        });

        // First save might fail with transaction error, catch and retry
        try {
          await ticket.save(session ? { session } : undefined);
        } catch (error: any) {
          if (error.message?.includes('Transaction numbers are only allowed on a replica set')) {
            console.warn('⚠️  MongoDB transactions not supported. Continuing without transaction.');
            if (session) {
              await session.abortTransaction();
              session.endSession();
            }
            // Retry ALL tickets without a session — same per-line flattening,
            // or this fallback would silently mint the wrong tiers.
            const ticketsWithoutSession: ITicket[] = [];
            for (const retryTier of flattened) {
              const t = this.buildTicket({
                eventId,
                vendorId,
                ticketType: retryTier.name,
                price: retryTier.price,
                customerName,
                customerPhone,
                customerEmail,
                buyerId,
                currency: displayCurrency,
              });
              await t.save();
              ticketsWithoutSession.push(t);
            }

            // Create sale without session
            const saleWithoutSession = new TicketSale({
              eventId,
              vendorId,
              ticketIds: ticketsWithoutSession.map(t => t._id),
              quantity,
              lines: saleLines,
              customerName,
              customerPhone,
              ...(customerEmail ? { customerEmail: customerEmail.toLowerCase() } : {}),
              ...(buyerId ? { buyerId } : {}),
              totalAmount,
              paymentMethod,
              paymentStatus,
              walletTransactionId,
              soldBy,
              soldByType: mappedSoldByType,
              channel,
              ...resellerAttribution,
              ...econ,
              ...feeSnapshot,
              soldAt: new Date()
            });
            await saleWithoutSession.save();

            // Update ticket sale IDs
            await Ticket.updateMany(
              { _id: { $in: ticketsWithoutSession.map(t => t._id) } },
              { saleId: saleWithoutSession._id }
            );

            // Update event ticket counts — PER LINE. Each tier's own `sold`
            // counter moves by its own quantity, and revenue by its own
            // subtotal (updateTicketsSold withholds an allocation line's
            // proceeds from organizer revenue on its own).
            for (const line of resolvedLines) {
              await EventService.updateTicketsSold(
                eventId,
                line.ticketTypeId,
                line.quantity,
                round2(line.ticketType.price * line.quantity)
              );
            }

            await this.autoFollowOrganizerForSale(saleWithoutSession);

            return {
              sale: saleWithoutSession,
              tickets: ticketsWithoutSession,
              paymentMessage
            };
          }
          throw error;
        }

        tickets.push(ticket);
      }

      // Create sale record
      const sale = new TicketSale({
        eventId,
        vendorId,
        ticketIds: tickets.map(t => t._id),
        quantity,
        lines: saleLines,
        customerName,
        customerPhone,
        ...(customerEmail ? { customerEmail: customerEmail.toLowerCase() } : {}),
        ...(buyerId ? { buyerId } : {}),
        totalAmount,
        paymentMethod,
        paymentStatus,
        walletTransactionId,
        soldBy,
        soldByType: mappedSoldByType,
        channel,
        ...resellerAttribution,
        ...econ,
        ...feeSnapshot,
        soldAt: new Date()
      });
      await sale.save(session ? { session } : undefined);

      // Update ticket sale IDs
      await Ticket.updateMany(
        { _id: { $in: tickets.map(t => t._id) } },
        { saleId: sale._id },
        session ? { session } : {}
      );

      // Update event ticket counts — PER LINE, so each tier's own `sold`
      // counter moves by its own quantity rather than the whole cart landing
      // on one tier.
      for (const line of resolvedLines) {
        await EventService.updateTicketsSold(
          eventId,
          line.ticketTypeId,
          line.quantity,
          round2(line.ticketType.price * line.quantity)
        );
      }

      if (session) {
        await session.commitTransaction();
      }

      await this.autoFollowOrganizerForSale(sale);

      return {
        sale,
        tickets,
        paymentMessage
      };
    } catch (error: any) {
      if (session && session.inTransaction()) {
        await session.abortTransaction();
      }
      console.error('Sell tickets error:', error);
      throw new Error(error.message || 'Failed to sell tickets');
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }

  /**
   * Get sales with filters and pagination
   */
  static async getSales(query: GetSalesQuery) {
    try {
      const {
        vendorId,
        eventId,
        paymentMethod,
        paymentStatus,
        channel,
        startDate,
        endDate,
        page = 1,
        limit = 20,
        isSuperAdmin = false
      } = query;

      // Build query — superadmins see sales across every vendor's events.
      const filter: any = {};
      if (!isSuperAdmin) filter.vendorId = vendorId;

      if (eventId) filter.eventId = eventId;
      if (paymentMethod) filter.paymentMethod = paymentMethod;
      // Organizers only ever see paid sales — failed/pending online payment
      // attempts are platform noise reserved for Carrot super-admins, and this
      // must hold even if the client passes an explicit paymentStatus filter.
      if (isSuperAdmin) {
        if (paymentStatus) filter.paymentStatus = paymentStatus;
      } else {
        filter.paymentStatus = PaymentStatus.COMPLETED;
      }
      if (channel) filter.channel = channel;

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [sales, total] = await Promise.all([
        TicketSale.find(filter)
          .populate('eventId', 'name venue eventDate')
          // Populate the individual tickets so the dashboard can show the
          // ticket type and the scannable ticket code(s) in sales tables.
          .populate('ticketIds', 'ticketId ticketType status')
          .populate('soldBy')
          .populate('resellerId', 'name')
          .populate('hubId', 'name')
          .sort({ soldAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        TicketSale.countDocuments(filter)
      ]);

      return {
        // The dashboard reads `sale.event.name`; populate() puts the event doc
        // on `eventId`, so expose it as `event` and keep `eventId` a plain id.
        data: sales.map(withEvent),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      console.error('Get sales error:', error);
      throw new Error(error.message || 'Failed to fetch sales');
    }
  }

  /**
   * Get single sale by ID
   */
  static async getSaleById(saleId: string, vendorId: string): Promise<ITicketSale> {
    try {
      const sale = await TicketSale.findOne({
        _id: saleId,
        vendorId
      })
        .populate('eventId', 'name venue eventDate')
        .populate('ticketIds')
        .populate('soldBy');

      if (!sale) {
        throw new Error('Sale not found');
      }

      return sale;
    } catch (error: any) {
      console.error('Get sale by ID error:', error);
      throw new Error(error.message || 'Failed to fetch sale');
    }
  }

  /**
   * Refund ticket
   */
  static async refundTicket(
    ticketId: string,
    vendorId: string,
    reason?: string
  ): Promise<ITicket> {
    const session = await this.startSessionSafely();

    try {
      // Find ticket
      const ticket = await Ticket.findOne({
        ticketId,
        vendorId
      }).session(session || null);

      if (!ticket) {
        throw new Error('Ticket not found');
      }

      // Check if ticket can be refunded
      if (ticket.status === TicketStatus.REFUNDED) {
        throw new Error('Ticket is already refunded');
      }

      if (ticket.status === TicketStatus.CHECKED_IN) {
        throw new Error('Cannot refund checked-in ticket');
      }

      if (ticket.status !== TicketStatus.SOLD) {
        throw new Error('Only sold tickets can be refunded');
      }

      // Get sale info
      const sale = await TicketSale.findById(ticket.saleId).session(session || null);
      if (!sale) {
        throw new Error('Sale record not found');
      }

      // Update ticket status
      ticket.status = TicketStatus.REFUNDED;
      await ticket.save(session ? { session } : undefined);

      // Record the refund on the sale. The sale stays COMPLETED — the money
      // was collected — and analytics read totalAmount − refundedAmount /
      // quantity − refundedQuantity, so this is what makes revenue, cash and
      // tickets-sold figures drop with the ticket.
      sale.refundedQuantity = (sale.refundedQuantity ?? 0) + 1;
      sale.refundedAmount = (sale.refundedAmount ?? 0) + ticket.price;
      await sale.save(session ? { session } : undefined);

      // Update event stats
      const event = await Event.findById(ticket.eventId).session(session || null);
      if (event) {
        const ticketTypeObj = event.ticketTypes.find(tt => tt.name === ticket.ticketType);
        if (ticketTypeObj) {
          ticketTypeObj.sold -= 1;
          ticketTypeObj.available = ticketTypeObj.quantity - ticketTypeObj.sold;
        }
        event.totalTicketsSold -= 1;
        event.totalRevenue -= ticket.price;
        await event.save(session ? { session } : undefined);
      }

      if (session) {
        await session.commitTransaction();
      }

      return ticket;
    } catch (error: any) {
      if (session) {
        await session.abortTransaction();
      }
      console.error('Refund ticket error:', error);
      throw new Error(error.message || 'Failed to refund ticket');
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }

  /**
   * Get tickets for an event
   */
  static async getEventTickets(
    eventId: string,
    vendorId: string,
    status?: TicketStatus
  ): Promise<ITicket[]> {
    try {
      const filter: any = { eventId, vendorId };
      if (status) filter.status = status;

      const tickets = await Ticket.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      return tickets;
    } catch (error: any) {
      console.error('Get event tickets error:', error);
      throw new Error(error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Batch-issue zero-amount tickets for printed wristbands (dashboard
   * Wristbands tab, platform-staff-only). The tickets are REAL — same
   * TKT- code space, same scan path — but the sale is recorded on the
   * `wristband` channel with a 0 economic snapshot, so revenue reports are
   * unaffected while capacity and scan analytics stay honest.
   *
   * Deliberately no mongo session: this is a low-volume admin operation and
   * the sellTickets transaction/fallback machinery would triple the code for
   * no customer-facing benefit. Any mid-flight failure surfaces loudly and
   * the batch is simply re-run.
   */
  static async issueWristbandBatch(params: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    issuedBy?: string;
  }): Promise<{ sale: ITicketSale; tickets: ITicket[] }> {
    const { eventId, ticketTypeId, quantity } = params;

    const availabilityCheck = await EventService.checkTicketAvailability(eventId, ticketTypeId, quantity);
    if (!availabilityCheck.available) {
      throw new Error(availabilityCheck.message || 'Tickets not available');
    }
    const ticketTypeData = availabilityCheck.ticketTypeData!;

    const event = await Event.findById(eventId).select('vendorId ticketing currency').lean();
    if (!event) throw new Error('Event not found');
    // Guard: an externally-sold event shouldn't get Carrot-issued admission
    // either — this batch mints real, scannable tickets. Does NOT route
    // through sellTickets, so it needs its own check.
    assertCarrotTicketing(event as any);
    const vendorId = (event as any).vendorId;
    const soldBy = params.issuedBy ?? vendorId;
    // Legacy-doc default only — every current event carries `currency`.
    const displayCurrency: EventCurrency = (event as any).currency ?? 'SZL';

    const econ = await this.buildSaleSnapshot({
      totalAmount: 0,
      paymentMethod: PaymentMethod.CASH,
      mappedSoldByType: 'Vendor',
      displayCurrency,
    });

    const tickets: ITicket[] = [];
    for (let i = 0; i < quantity; i++) {
      const ticket = this.buildTicket({
        eventId,
        vendorId,
        ticketType: ticketTypeData.name,
        price: 0,
        currency: displayCurrency,
      });
      await ticket.save();
      tickets.push(ticket);
    }

    const sale = new TicketSale({
      eventId,
      vendorId,
      ticketIds: tickets.map((t) => t._id),
      quantity,
      totalAmount: 0,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.COMPLETED,
      soldBy,
      soldByType: 'Vendor',
      channel: SalesChannel.WRISTBAND,
      ...econ,
      serviceFeeAmount: 0,
      amountCharged: 0,
      soldAt: new Date(),
    });
    await sale.save();

    await Ticket.updateMany({ _id: { $in: tickets.map((t) => t._id) } }, { saleId: sale._id });
    await EventService.updateTicketsSold(eventId, ticketTypeId, quantity, 0);

    return { sale, tickets };
  }

  /**
   * Buy ticket(s) for an end customer paying with their Keshless wallet.
   *
   * This is the single source of truth for the buyer purchase flow: the
   * public/web buyer checkout (PublicController) and the in-app proxy
   * checkout (TicketsController.purchaseAsUser) both call it, so the process
   * and the amount charged are guaranteed identical. The buyer pays exactly
   * price x quantity — there is no separate add-on fee.
   */
  static async purchaseForCustomer(params: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    // Optional — email-only buyers (no verified phone on file) have none.
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — stamped on the sale
    // + tickets so "My Tickets" / findTicketsForBuyer can match them.
    customerEmail?: string;
    buyerId?: string;
    keshlessCardNumber: string;
    keshlessPin?: string;
  }): Promise<{
    tickets: Array<{
      ticketId: string;
      eventName: string;
      ticketType: string;
      eventDate: Date;
      startTime?: Date;
      venue: string;
    }>;
    transactionId?: string;
    totalAmount: number;
    quantity: number;
    event: { name: string; date: Date; venue: string };
  }> {
    const {
      eventId,
      items,
      customerEmail,
      buyerId,
      keshlessCardNumber,
      keshlessPin,
    } = params;

    const customerPhone = params.customerPhone ? normalizePhone(params.customerPhone) : undefined;
    // Name only personalises the printed ticket; fall back to phone, then
    // email, so an email-only buyer's ticket is never nameless.
    const customerName = params.customerName?.trim() || customerPhone || params.customerEmail || 'Guest';

    // One call replaces the hand-rolled event lookup, sold-out check,
    // restrictToMethod guard and fee computation that used to live here — and
    // adds the per-account cap across the whole cart. Every rail shares it, so
    // none of them can drift from another.
    const cart = await resolveCart({
      eventId,
      items,
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId,
      phone: customerPhone,
    });
    const event = cart.event;
    const { faceTotal: totalAmount, serviceFeeAmount, absorbedServiceFeeAmount } = cart;
    const quantity = cart.totalQuantity;

    // PIN threshold keys off the FACE subtotal (the service fee must not shift
    // the PIN rule). Buyer-paid service fee is added on top of face.
    if (totalAmount >= 50 && !keshlessPin) {
      throw new Error('PIN required for purchases of E50 or more');
    }

    // sellTickets debits the wallet (face + service fee) and mints tickets.
    const result = await TicketService.sellTickets({
      vendorId: event.vendorId!.toString(),
      eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      customerName,
      customerPhone,
      customerEmail,
      buyerId,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      keshlessCardNumber,
      keshlessPin,
      soldBy: event.vendorId!.toString(),
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
      serviceFeeAmount,
      absorbedServiceFeeAmount,
    });

    this.sendTicketConfirmations(event, result.tickets, customerPhone, customerEmail);

    return {
      // Each ticket reports ITS OWN tier — a mixed cart has more than one, so
      // naming a single tier here would mislabel every ticket but the first's.
      tickets: result.tickets.map(ticket => ({
        ticketId: ticket.ticketId,
        eventName: event.name,
        ticketType: ticket.ticketType,
        eventDate: event.eventDate,
        startTime: event.startTime,
        venue: event.venue,
      })),
      transactionId: result.sale.walletTransactionId,
      totalAmount,
      quantity,
      event: { name: event.name, date: event.eventDate, venue: event.venue },
    };
  }

  /**
   * Best-effort ticket confirmation (SMS + email) for a completed online
   * issue. Fire-and-forget: a send failure is logged but never rolls back the
   * purchase — the buyer already has the ticket. Shared by the wallet purchase
   * and the free-claim path so both notify identically.
   */
  private static sendTicketConfirmations(
    event: { name: string; eventDate: Date; startTime?: Date; venue: string },
    tickets: ITicket[],
    customerPhone?: string,
    customerEmail?: string,
  ): void {
    const summaries = tickets.map((t) => ({
      ticketId: t.ticketId,
      eventName: event.name,
      eventDate: event.eventDate.toISOString(),
      startTime: event.startTime?.toISOString(),
      venue: event.venue,
    }));
    if (customerPhone) {
      SmsService.sendTicketConfirmation(customerPhone, summaries)
        .catch((err) => console.error('[SMS] confirmation send threw', err));
    }
    if (customerEmail) {
      EmailService.sendTicketConfirmation(customerEmail, summaries)
        .catch((err) => console.error('[Email] confirmation send threw', err));
    }
  }

  /**
   * Claim a FREE ticket — the buyer-checkout path for a tier priced at 0.
   * No payment method, no gateway: a free ticket has nothing to charge, so the
   * buyer never sees a payment picker (see PurchaseModal). Mints through the
   * same choke point as every other sale (sellTickets → CashProcessor, which
   * moves no money) so the ticket, ledger snapshot and auto-follow behave
   * exactly like a paid online sale, just at amount 0.
   *
   * SERVER-AUTHORITATIVE: the tier's price MUST be 0. The client saying "this
   * is free" is never trusted — a paid tier rejected here has to go through a
   * real payment method, so this endpoint can't be used to mint paid tickets
   * for free.
   */
  static async claimFreeTicket(params: {
    eventId: string;
    /** One entry per tier. Every line must be genuinely free. */
    items: CartLine[];
    customerPhone?: string;
    customerName?: string;
    customerEmail?: string;
    buyerId?: string;
  }): Promise<{
    tickets: Array<{
      ticketId: string;
      eventName: string;
      ticketType: string;
      eventDate: Date;
      startTime?: Date;
      venue: string;
    }>;
    totalAmount: number;
    quantity: number;
    event: { name: string; date: Date; venue: string };
  }> {
    const { eventId, items, customerEmail, buyerId } = params;

    const customerPhone = params.customerPhone ? normalizePhone(params.customerPhone) : undefined;
    // Name only personalises the printed ticket; fall back to phone, then
    // email, so an email-only buyer's ticket is never nameless.
    const customerName = params.customerName?.trim() || customerPhone || params.customerEmail || 'Guest';

    const cart = await resolveCart({
      eventId,
      items,
      method: PaymentMethod.CASH,
      buyerId,
      phone: customerPhone,
    });
    const event = cart.event;
    const quantity = cart.totalQuantity;

    // The whole point of this path: it mints without taking any money, so
    // EVERY line must be genuinely free, checked against the stored tier price
    // and never the caller's word. One paid line must not ride along in a cart
    // of free ones.
    const paidLine = cart.lines.find((l) => l.unitPrice > 0);
    if (paidLine) {
      throw new Error(`${paidLine.ticketType.name} is not free — please choose a payment method`);
    }

    // sellTickets mints via the CashProcessor (no money moves) at face 0.
    const result = await TicketService.sellTickets({
      vendorId: event.vendorId!.toString(),
      eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      customerName,
      customerPhone,
      customerEmail,
      buyerId,
      paymentMethod: PaymentMethod.CASH,
      soldBy: event.vendorId!.toString(),
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
      serviceFeeAmount: 0,
    });

    this.sendTicketConfirmations(event, result.tickets, customerPhone, customerEmail);

    return {
      // Each ticket reports ITS OWN tier — a mixed cart has more than one, so
      // naming a single tier here would mislabel every ticket but the first's.
      tickets: result.tickets.map(ticket => ({
        ticketId: ticket.ticketId,
        eventName: event.name,
        ticketType: ticket.ticketType,
        eventDate: event.eventDate,
        startTime: event.startTime,
        venue: event.venue,
      })),
      totalAmount: 0,
      quantity,
      event: { name: event.name, date: event.eventDate, venue: event.venue },
    };
  }

  /**
   * Find every ticket whose customerPhone matches an authenticated user's
   * phone. Used by the Keshless user-app's "My Tickets" tab. Event details
   * are populated so the Flutter card can render event name/date/venue
   * without a follow-up call per ticket.
   *
   * Phone comparison is exact match on the same string we wrote during
   * purchase (see ticket creation in sellTickets, line ~160). If users
   * register their wallet phone in E.164 (+268…) and we also store the
   * purchase form's phone in E.164, this works. If formats diverge, this
   * lookup will under-match and we'll need a normalization step here.
   */
  static async findTicketsByCustomerPhone(phone: string): Promise<ITicket[]> {
    try {
      // Normalise here so every caller (buyer login, user-app proxy, curl)
      // matches the same way tickets are written at purchase.
      const normalized = normalizePhone(phone);
      const tickets = await Ticket.find({ customerPhone: normalized })
        .populate('eventId', 'name venue eventDate startTime endTime posterUrl')
        .sort({ createdAt: -1 })
        .lean();
      return tickets;
    } catch (error: any) {
      console.error('[my-tickets] find by phone error:', error);
      throw new Error(error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Find every ticket belonging to a buyer, matching by whichever handles
   * they have — buyerId (canonical, stamped on tickets purchased while
   * logged in), customerPhone, or customerEmail (both normalized the same
   * way tickets are written at purchase). This is the buyerId/email-aware
   * successor to findTicketsByCustomerPhone: an email-only buyer's tickets
   * are found even though they have no phone to match on.
   *
   * Uses the DRY $or builder (buyerTicketOr) shared with the ticket-holder
   * checks (message/review/community-membership gating) so the match
   * contract can never drift between "My Tickets" and "can this buyer post".
   */
  static async findTicketsForBuyer(
    buyer: { _id: any; phone?: string; email?: string }
  ): Promise<ITicket[]> {
    try {
      const tickets = await Ticket.find({ $or: buyerTicketOr(buyer) })
        .populate('eventId', 'name venue eventDate startTime endTime posterUrl')
        .sort({ createdAt: -1 })
        .lean();
      return tickets;
    } catch (error: any) {
      console.error('[my-tickets] find for buyer error:', error);
      throw new Error(error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Get ticket by ID
   */
  static async getTicketById(ticketId: string, vendorId: string): Promise<ITicket> {
    try {
      const ticket = await Ticket.findOne({ ticketId, vendorId })
        .populate('eventId', 'name venue eventDate')
        .populate('saleId');

      if (!ticket) {
        throw new Error('Ticket not found');
      }

      return ticket;
    } catch (error: any) {
      console.error('Get ticket by ID error:', error);
      throw new Error(error.message || 'Failed to fetch ticket');
    }
  }

  // ── MTN MoMo async payment client (mocked in tests via jest.mock at module level) ──
  private static momoClient = new MtnMomoClient();
  // ── Peach card async payment client (mocked in tests via jest.mock at module level) ──
  private static peachClient = new PeachClient();
  // ── DeltaPay hosted-checkout client (mocked in tests via jest.mock at module level) ──
  private static deltapayClient = new DeltapayClient();
  private static MOMO_TTL_MS = 5 * 60_000; // 5 minutes
  private static CARD_TTL_MS = 15 * 60_000; // 15 min — card redirect (3DS/OTP) takes longer than MoMo
  // 12 min — deliberately LONGER than DeltaPay's hard 10-min session expiry, so the
  // inventory hold never lapses while a payment could still legitimately land.
  private static DELTAPAY_TTL_MS = 12 * 60_000;
  // ── Yoco hosted-checkout client (mocked in tests via jest.mock at module level) ──
  private static yocoClient = new YocoClient();

  // ── YeboPay hosted-checkout client (mocked in tests via jest.mock at module level) ──
  private static yebopayClient = new YeboPayClient();
  // 15 min — matches the Peach card hold: a hosted card page plus 3-D Secure
  // takes appreciably longer than a wallet approval.
  private static YOCO_TTL_MS = 15 * 60_000;

  // YeboPay hosted checkouts live 24h provider-side, but Carrot holds inventory
  // for far less — the hold, not the checkout, is what bounds the buyer's window.
  private static YEBOPAY_TTL_MS = 15 * 60_000;

  /**
   * Initiate an async MTN MoMo purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Call requestToPay on MTN — on failure, release reservation + fail sale + rethrow.
   */
  static async initiateMomoPurchase(p: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    // Contact/attribution phone — optional because an email-only buyer may
    // not have one (the MoMo wallet number to actually debit is the
    // separate, still-required `momoPhone` field below).
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — persisted on the
    // PENDING sale so finalizeMomoSale can stamp it onto the minted tickets.
    customerEmail?: string;
    buyerId?: string;
    momoPhone: string;
    // Optional reseller attribution (additive — buyer/vendor callers omit these
    // and keep the existing vendor-default behavior). When provided, the PENDING
    // sale carries the SAME snapshot shape as a reseller cash sale except
    // fundsCustody derives to 'carrot' because MoMo is electronic.
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ referenceId: string; saleId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new Error('MTN MoMo is not available');


    // Attribution is resolved FIRST because resolveCart needs the channel to
    // decide whether a buyer service fee applies at all (ONLINE only).
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);

    // One call replaces the availability check, price maths, event load,
    // ticketing guard, restrictToMethod guard and fee computation this rail
    // used to carry itself — and adds the per-account cap across the cart.
    const cart = await resolveCart({
      eventId: p.eventId,
      items: p.items,
      method: PaymentMethod.MTN_MOMO,
      buyerId: p.buyerId,
      phone: p.customerPhone,
      channel,
    });
    const event = cart.event;
    const totalAmount = cart.faceTotal;
    const { serviceFeeAmount, amountCharged, absorbedServiceFeeAmount } = cart;
    // Attribution tier — resolveCart guarantees every line in a cart shares
    // one owner, so the first line speaks for all of them.
    const tt = cart.lines[0]!.ticketType;
    // Composition snapshot the finalizer mints from (see TicketSale.lines).
    const saleLines = cart.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      ticketTypeName: l.ticketType.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    }));

    // vendorId is the event organizer (derive from the event if absent, as the
    // buyer/vendor path does today). soldBy defaults to the organizer.
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Immutable economic snapshot — an electronic (mtn_momo) sale, so custody
    // derives to 'carrot'. Computed via the SAME DRY helper used everywhere so
    // a reseller MoMo initiate yields organizerProceeds = face − commission −
    // Service fee — ONLINE checkout only (reseller/POS stay at face). Computed
    // BEFORE the economic snapshot because on an event whose organizer absorbs
    // the fee, the buyer is charged face and the fee becomes a deduction from
    // organizerProceeds — so the snapshot below needs the amount.

    // fee with soldByType 'ResellerOperator'. Written now so the sale is
    // ledger-visible even before tickets are minted at finalize.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.MTN_MOMO,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
      displayCurrency: event.currency ?? 'SZL',
      absorbedServiceFeeAmount,
    });
    // An allocation tier's sale is always attributed to the tier's owning
    // reseller (kept off the organizer's revenue, held for their settlement),
    // even for an online buyer who carries no reseller context.
    const saleResellerId = resolveSaleResellerId(tt, p.resellerId ? String(p.resellerId) : undefined);
    const resellerAttribution = {
      ...(saleResellerId ? { resellerId: saleResellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      ...(tt.isAllocation ? { isAllocation: true } : {}),
    };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: cart.totalQuantity,
      lines: saleLines,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      totalAmount,
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      saleId: sale._id.toString(),
      ttlMs: this.MOMO_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Request to pay (currency from env; sandbox uses EUR)
    try {
      // MTN keys its directory on the FULL international MSISDN with no '+'
      // (e.g. 26876707421). A bare local number like 76707421 returns
      // PAYER_NOT_FOUND, so normalise to +268… then strip the leading '+'.
      const payerMsisdn = normalizePhone(p.momoPhone).replace(/^\+/, '');
      const { referenceId } = await this.momoClient.requestToPay({
        amount: amountCharged,
        currency: process.env['MTN_MOMO_CURRENCY'] || 'SZL',
        payerMsisdn,
        externalId: sale.saleId,
        payerMessage: cart.lines.length === 1
          ? `Carrot Tickets - ${tt.name} x${cart.totalQuantity}`
          : `Carrot Tickets - ${cart.totalQuantity} tickets (${cart.lines.length} types)`,
      });
      sale.momoReferenceId = referenceId;
      await sale.save();
      return { referenceId, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a MoMo sale by its MTN referenceId for ownership verification.
   * Returns null if not found. Never throws.
   */
  static async getMomoSaleByReference(referenceId: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ momoReferenceId: referenceId });
  }

  /**
   * Look up a MoMo sale by the externalId we sent to MTN (= sale.saleId).
   * MTN's requesttopay callback carries `externalId`, NOT our X-Reference-Id,
   * so this is how we correlate an inbound callback back to its sale.
   * Returns null if not found. Never throws.
   */
  static async getMomoSaleByExternalId(externalId: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ saleId: externalId });
  }

  /**
   * Initiate an async Peach card purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Call createPayment on Peach — on failure, release reservation + fail sale + rethrow.
   *
   * Mirrors initiateMomoPurchase exactly; differences: no payer phone,
   * paymentMethod = PaymentMethod.PEACH_CARD, provider call is peachClient.createPayment.
   */
  static async initiateCardPurchase(p: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — persisted on the
    // PENDING sale so finalizeCardSale can stamp it onto the minted tickets.
    customerEmail?: string;
    buyerId?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ paymentId: string; redirect: any; saleId: string; expiresAt: Date }> {
    if (!this.peachClient.isConfigured()) throw new Error('Card payments are not available');

    const cardCfg = await PaymentConfigService.get();
    if (!cardCfg.peachCardEnabled) throw new Error('Card payments are not available');


    // Attribution is resolved FIRST because resolveCart needs the channel to
    // decide whether a buyer service fee applies at all (ONLINE only).
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);

    // One call replaces the availability check, price maths, event load,
    // ticketing guard, restrictToMethod guard and fee computation this rail
    // used to carry itself — and adds the per-account cap across the cart.
    const cart = await resolveCart({
      eventId: p.eventId,
      items: p.items,
      method: PaymentMethod.PEACH_CARD,
      buyerId: p.buyerId,
      phone: p.customerPhone,
      channel,
    });
    const event = cart.event;
    const totalAmount = cart.faceTotal;
    const { serviceFeeAmount, amountCharged, absorbedServiceFeeAmount } = cart;
    // Attribution tier — resolveCart guarantees every line in a cart shares
    // one owner, so the first line speaks for all of them.
    const tt = cart.lines[0]!.ticketType;
    // Composition snapshot the finalizer mints from (see TicketSale.lines).
    const saleLines = cart.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      ticketTypeName: l.ticketType.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    }));

    // Attribution: mirror initiateMomoPurchase defaults exactly. soldByType /
    // channel are resolved above, before resolveCart needs the channel.
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Service fee — ONLINE checkout only (reseller/POS stay at face). Computed
    // BEFORE the economic snapshot because on an event whose organizer absorbs
    // the fee, the buyer is charged face and the fee becomes a deduction from
    // organizerProceeds — so the snapshot below needs the amount.

    // Immutable economic snapshot — card is electronic so custody derives to 'carrot'.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.PEACH_CARD,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
      displayCurrency: event.currency ?? 'SZL',
      absorbedServiceFeeAmount,
    });
    // An allocation tier's sale is always attributed to the tier's owning
    // reseller (kept off the organizer's revenue, held for their settlement),
    // even for an online buyer who carries no reseller context.
    const saleResellerId = resolveSaleResellerId(tt, p.resellerId ? String(p.resellerId) : undefined);
    const resellerAttribution = {
      ...(saleResellerId ? { resellerId: saleResellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      ...(tt.isAllocation ? { isAllocation: true } : {}),
    };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: cart.totalQuantity,
      lines: saleLines,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      totalAmount,
      paymentMethod: PaymentMethod.PEACH_CARD,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      saleId: sale._id.toString(),
      ttlMs: this.CARD_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Create Peach payment; on failure release + fail + rethrow (no silent fallback)
    if (!process.env['CARD_RESULT_URL']) throw new Error('CARD_RESULT_URL is not configured');
    try {
      const nonce = sale.saleId + '-' + sale._id.toString();
      const { id, redirect } = await this.peachClient.createPayment({
        amount: amountCharged,
        currency: process.env['CARD_CURRENCY'] || 'ZAR',
        merchantTransactionId: sale.saleId,
        shopperResultUrl: process.env['CARD_RESULT_URL']!,
        nonce,
      });
      sale.peachPaymentId = id;
      await sale.save();
      return { paymentId: id, redirect, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a card sale by its Peach payment ID.
   * Returns null if not found. Never throws.
   */
  static async getCardSaleByPaymentId(id: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ peachPaymentId: id });
  }

  /**
   * Initiate an async DeltaPay hosted-checkout purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Create the hosted-checkout session — on failure, release reservation +
   *    fail sale + rethrow (never a silent fallback; the buyer sees the error).
   *
   * Mirrors initiateCardPurchase; differences: paymentMethod = DELTAPAY, the
   * provider call is deltapayClient.createSession, and the buyer's phone is
   * offered upfront as the payer identifier to skip a step on DeltaPay's page.
   */
  static async initiateDeltapayPurchase(p: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — persisted on the
    // PENDING sale so finalizeDeltapaySale can stamp it onto the minted tickets.
    customerEmail?: string;
    buyerId?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ checkoutSessionId: string; checkoutUrl: string; saleId: string; expiresAt: Date }> {
    if (!this.deltapayClient.isConfigured()) throw new Error('DeltaPay is not available');

    // Checked up-front, BEFORE any sale row or inventory hold exists — a throw
    // after the reserve would strand held tickets until the expiry sweep.
    const returnUrl = process.env['DELTAPAY_RETURN_URL'];
    if (!returnUrl) throw new Error('DELTAPAY_RETURN_URL is not configured');

    const cfg = await PaymentConfigService.get();
    if (!cfg.deltapayEnabled) throw new Error('DeltaPay is not available');


    // Attribution is resolved FIRST because resolveCart needs the channel to
    // decide whether a buyer service fee applies at all (ONLINE only).
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);

    // One call replaces the availability check, price maths, event load,
    // ticketing guard, restrictToMethod guard and fee computation this rail
    // used to carry itself — and adds the per-account cap across the cart.
    const cart = await resolveCart({
      eventId: p.eventId,
      items: p.items,
      method: PaymentMethod.DELTAPAY,
      buyerId: p.buyerId,
      phone: p.customerPhone,
      channel,
    });
    const event = cart.event;
    const totalAmount = cart.faceTotal;
    const { serviceFeeAmount, amountCharged, absorbedServiceFeeAmount } = cart;
    // Attribution tier — resolveCart guarantees every line in a cart shares
    // one owner, so the first line speaks for all of them.
    const tt = cart.lines[0]!.ticketType;
    // Composition snapshot the finalizer mints from (see TicketSale.lines).
    const saleLines = cart.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      ticketTypeName: l.ticketType.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    }));

    // Attribution: mirror initiateCardPurchase defaults exactly.
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Service fee — ONLINE checkout only (reseller/POS stay at face). Computed
    // BEFORE the economic snapshot because on an event whose organizer absorbs
    // the fee, the buyer is charged face and the fee becomes a deduction from
    // organizerProceeds — so the snapshot below needs the amount.

    // Immutable economic snapshot — DeltaPay is electronic so custody derives to 'carrot'.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.DELTAPAY,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
      displayCurrency: event.currency ?? 'SZL',
      absorbedServiceFeeAmount,
    });
    // An allocation tier's sale is always attributed to the tier's owning
    // reseller (kept off the organizer's revenue, held for their settlement),
    // even for an online buyer who carries no reseller context.
    const saleResellerId = resolveSaleResellerId(tt, p.resellerId ? String(p.resellerId) : undefined);
    const resellerAttribution = {
      ...(saleResellerId ? { resellerId: saleResellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      ...(tt.isAllocation ? { isAllocation: true } : {}),
    };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: cart.totalQuantity,
      lines: saleLines,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      totalAmount,
      paymentMethod: PaymentMethod.DELTAPAY,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      saleId: sale._id.toString(),
      ttlMs: this.DELTAPAY_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Create the hosted-checkout session; on failure release + fail + rethrow
    try {
      // Offer the buyer's phone upfront so DeltaPay can skip identifier entry.
      // An unknown/invalid identifier does NOT fail session creation — DeltaPay
      // falls back to prompting on its page — so this is safe to always send.
      const normalizedPhone = p.customerPhone ? normalizePhone(p.customerPhone) : '';
      const payerIdentifier = /^\+\d{10,15}$/.test(normalizedPhone) ? normalizedPhone : undefined;

      // Thread OUR reference through the return URL. DeltaPay's return redirect
      // carries no query parameters of its own, so without this the return
      // handler cannot tell which sale the buyer is coming back from.
      // This is a LOOKUP HINT ONLY — never proof of anything. Whatever it
      // resolves to is still put through finalizeDeltapaySale, which asks
      // DeltaPay via verify-return and mints only on `succeeded` with an exact
      // amount match. A forged or guessed ref therefore grants nothing.
      const returnUrlWithRef = new URL(returnUrl);
      returnUrlWithRef.searchParams.set('ref', sale.saleId);

      const session = await this.deltapayClient.createSession({
        amount: amountCharged,
        merchantReference: sale.saleId,
        returnUrl: returnUrlWithRef.toString(),
        displayDescription: (cart.lines.length === 1
          ? `${cart.totalQuantity} x ${tt.name || 'Ticket'} — ${event.name}`
          : `${cart.totalQuantity} tickets (${cart.lines.length} types) — ${event.name}`).slice(0, 200),
        ...(process.env['DELTAPAY_CALLBACK_URL']
          ? { sessionCallbackUrl: process.env['DELTAPAY_CALLBACK_URL'] }
          : {}),
        ...(payerIdentifier
          ? { payerIdentifier, payerIdentifierType: 'phone_number' as const }
          : {}),
      });

      sale.deltapaySessionId = session.checkoutSessionId;
      await sale.save();
      return {
        checkoutSessionId: session.checkoutSessionId,
        checkoutUrl: session.checkoutUrl,
        saleId: sale._id.toString(),
        expiresAt,
      };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a DeltaPay sale by its hosted-checkout session ID.
   * Returns null if not found. Never throws.
   */
  static async getDeltapaySaleBySessionId(
    sessionId: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ deltapaySessionId: sessionId });
  }

  /**
   * Look up a DeltaPay sale by OUR OWN merchant reference (sale.saleId).
   *
   * DeltaPay's return redirect arrives with NO query parameters at all — it does
   * not echo the checkout_session_id back (verified against the live dev
   * environment: `GET /deltapay/return` with an empty query string). So the
   * return handler has nothing to look the sale up by, and the buyer lands on a
   * result page that cannot tell them what happened.
   *
   * The fix is to thread a reference we control through the return_url query
   * when creating the session, and resolve it here. Scoped to DELTAPAY so a
   * reference cannot be used to reach a sale belonging to another method.
   */
  static async getDeltapaySaleByReference(
    reference: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ saleId: reference, paymentMethod: PaymentMethod.DELTAPAY });
  }

  /**
   * The signed-in buyer's most recent DeltaPay sale.
   *
   * This is the RELIABLE way to answer "did my payment go through?" after a
   * DeltaPay return. Everything carried on the redirect itself is unreliable —
   * DeltaPay echoes no identifiers back, and query parameters we add to
   * return_url are not guaranteed to survive either. But the buyer IS
   * authenticated in the SPA, so instead of trying to read something out of the
   * URL we simply look up their own latest DeltaPay purchase.
   *
   * Scoped to the caller's own phone, so a buyer can only ever reach their own
   * sale. Ordered by createdAt (not soldAt, which is set at initiation for every
   * pending sale and would tie) so "most recent attempt" is unambiguous.
   */
  /**
   * The signed-in buyer's most recent Yoco sale.
   *
   * Exists so the result page can report an outcome WITHOUT the return URL
   * having to carry an identifier — that URL is unauthenticated, so anything it
   * echoed would be readable by anyone holding a sale ref. Matching on the
   * buyer's own handles makes the answer unambiguous and unguessable.
   */
  static async getLatestYocoSaleForBuyer(
    buyer: { _id?: unknown; phone?: string; email?: string }
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({
      $or: buyerTicketOr(buyer),
      paymentMethod: PaymentMethod.YOCO,
      yocoCheckoutId: { $exists: true, $nin: [null, ''] },
    }).sort({ createdAt: -1 });
  }

  /**
   * ONE YeboPay sale by its reference, scoped to the buyer who owns it.
   *
   * Preferred over getLatestYeboPaySaleForBuyer: "latest" is ambiguous the
   * moment a buyer has two checkouts in flight (two tabs), where the result
   * page for the one they PAID would report the status of the other. Settlement
   * was never affected — that keys on yebopayCheckoutId — but the buyer could
   * be told "unconfirmed" for a payment that went through.
   *
   * The buyerTicketOr scope is what makes exposing the ref safe: `ref` travels
   * through YeboPay as metadata and is not secret, so this must never answer
   * for a sale the caller does not own. A foreign or unknown ref returns null,
   * which the caller reports identically to "no sale" — so this cannot be used
   * to probe whether a given ref exists.
   */
  static async getYeboPaySaleByRefForBuyer(
    ref: string,
    buyer: { _id?: unknown; phone?: string; email?: string }
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({
      $or: buyerTicketOr(buyer),
      saleId: ref,
      paymentMethod: PaymentMethod.YEBOPAY,
    });
  }

  /**
   * The buyer's most recent YeboPay sale.
   *
   * The YeboPay return redirect carries no identifiers on purpose — `ref` is
   * not secret (it is handed to YeboPay as metadata), so echoing a status for
   * it would let anyone turn a guessed ref into "does this sale exist, and was
   * it paid?". Same rule as the Yoco rail, so the result page asks an
   * AUTHENTICATED endpoint about the buyer's own latest sale instead of
   * parsing the address bar.
   */
  static async getLatestYeboPaySaleForBuyer(
    buyer: { _id?: unknown; phone?: string; email?: string }
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({
      $or: buyerTicketOr(buyer),
      paymentMethod: PaymentMethod.YEBOPAY,
      yebopayCheckoutId: { $exists: true, $nin: [null, ''] },
    }).sort({ createdAt: -1 });
  }

  static async getLatestDeltapaySaleForBuyer(
    buyer: { _id?: unknown; phone?: string; email?: string }
  ): Promise<InstanceType<typeof TicketSale> | null> {
    // Match by whichever handle(s) the buyer has (buyerId / phone / email) via
    // the shared buyerTicketOr contract, so an email-only buyer's latest
    // DeltaPay sale is found even without a phone.
    return TicketSale.findOne({
      $or: buyerTicketOr(buyer),
      paymentMethod: PaymentMethod.DELTAPAY,
      deltapaySessionId: { $exists: true, $nin: [null, ''] },
    }).sort({ createdAt: -1 });
  }

  /**
   * Finalize an MTN MoMo sale identified by referenceId. Idempotent.
   * - If sale is not PENDING → return current status immediately.
   * - Query MTN status; PENDING → return pending; FAILED → release + fail.
   * - SUCCESSFUL → ATOMIC claim via findOneAndUpdate({_id, paymentStatus:PENDING})
   *   to prevent double-mint from concurrent poll + callback. Then mint tickets,
   *   confirm reservation (reserved→sold), update event sold count, best-effort SMS.
   */
  static async finalizeMomoSale(referenceId: string): Promise<{ status: 'completed' | 'failed' | 'pending'; reason?: string }> {
    const sale = await TicketSale.findOne({ momoReferenceId: referenceId });
    if (!sale) {
      console.error('[momo finalize] ✗ no sale for reference', { referenceId });
      throw new Error('Sale not found for reference');
    }
    console.log('[momo finalize] → sale found', {
      referenceId,
      saleId: sale._id.toString(),
      paymentStatus: sale.paymentStatus,
      totalAmount: sale.totalAmount,
      quantity: sale.quantity,
      customerPhone: sale.customerPhone,
      eventId: sale.eventId?.toString(),
    });

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      console.log('[momo finalize] ↩ already finalized (idempotent)', {
        referenceId,
        paymentStatus: sale.paymentStatus,
      });
      return sale.paymentStatus === PaymentStatus.COMPLETED
        ? { status: 'completed' }
        : { status: 'failed', reason: sale.momoFailureReason };
    }

    const { status, raw } = await this.momoClient.getStatus(referenceId);
    console.log('[momo finalize] MTN status', { referenceId, status });
    if (status === 'PENDING') {
      console.log('[momo finalize] ↩ still PENDING — not minting yet', { referenceId });
      return { status: 'pending' };
    }

    if (status === 'FAILED') {
      const reason = typeof raw?.reason === 'string' ? raw.reason : undefined;
      console.warn('[momo finalize] ✗ MTN reports FAILED — releasing reservation', {
        referenceId,
        saleId: sale._id.toString(),
        reason,
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      if (reason) sale.momoFailureReason = reason;
      await sale.save();
      return { status: 'failed', reason };
    }

    // SUCCESSFUL — but verify MTN confirms the EXACT amount + currency we requested
    // before minting anything. The payer can only ever approve our requested amount,
    // so a mismatch means a bug, a currency drift, or a tampered/stale reference:
    // fail it LOUDLY rather than silently honour a charge that doesn't match the sale.
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    // Verify against what we actually charged (face + service fee). Fall back to
    // totalAmount for pre-service-fee sales that have no amountCharged.
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(raw?.amount);
    if (
      !Number.isFinite(confirmedAmount) ||
      confirmedAmount !== expectedAmount ||
      raw?.currency !== expectedCurrency
    ) {
      console.error('[momo finalize] amount/currency mismatch — refusing to mint', {
        referenceId,
        expected: { amount: expectedAmount, currency: expectedCurrency },
        confirmed: { amount: raw?.amount, currency: raw?.currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      sale.momoFailureReason = 'AMOUNT_MISMATCH';
      await sale.save();
      return { status: 'failed', reason: 'AMOUNT_MISMATCH' };
    }

    // atomically CLAIM the sale so concurrent poll + callback can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) {
      console.log('[momo finalize] ↩ claim lost — already finalized by concurrent poll/callback', {
        referenceId,
        saleId: sale._id.toString(),
      });
      return { status: 'completed' }; // someone else already finalized it
    }
    console.log('[momo finalize] ✓ claimed sale — minting tickets', {
      referenceId,
      saleId: sale._id.toString(),
      quantity: sale.quantity,
      financialTransactionId: raw?.financialTransactionId,
    });

    // Mint tickets, convert reservation (reserved→sold), SMS
    const event = await Event.findById(sale.eventId);
    // Mints from the sale's own composition snapshot, so every ticket carries
    // ITS tier's name and the price the buyer actually agreed to. If any of
    // this fails, fulfilClaimedSale releases the claim we just took so the
    // sale can be retried rather than stranded COMPLETED with no tickets.
    const tickets: ITicket[] = await this.fulfilClaimedSale(sale, claimed);

    if (event) {
      const summaries = tickets.map(t => ({
        ticketId: t.ticketId,
        eventName: event.name,
        eventDate: event.eventDate.toISOString(),
        startTime: event.startTime?.toISOString(),
        venue: event.venue,
      }));
      if (sale.customerPhone) {
        SmsService.sendTicketConfirmation(sale.customerPhone, summaries)
          .catch(err => console.error('[SMS] momo confirmation threw', err));
      }
      if (sale.customerEmail) {
        EmailService.sendTicketConfirmation(sale.customerEmail, summaries)
          .catch(err => console.error('[Email] momo confirmation threw', err));
      }
    }

    await this.autoFollowOrganizerForSale(claimed);

    console.log('[momo finalize] ✓ completed — tickets minted', {
      referenceId,
      saleId: sale._id.toString(),
      ticketCount: tickets.length,
      ticketIds: tickets.map(t => t.ticketId),
    });
    return { status: 'completed' };
  }

  /**
   * Finalize a Peach card sale identified by paymentId. Idempotent.
   * - If sale is not PENDING → return current status immediately (no re-mint).
   * - Query Peach status; pending code → return pending; rejected → release + fail.
   * - Success → AMOUNT/CURRENCY GUARD: Number(amount) must equal sale.totalAmount
   *   and currency must match CARD_CURRENCY env (default ZAR). Mismatch → release + fail.
   * - ATOMIC claim via findOneAndUpdate({_id, paymentStatus:PENDING}) to prevent
   *   double-mint from concurrent poll + webhook. Then mint tickets, confirm
   *   reservation (reserved→sold), update event sold count, best-effort SMS.
   *
   * Mirrors finalizeMomoSale exactly; differences: lookup by peachPaymentId,
   * status via peachClient.getPaymentStatus, amount guard uses CARD_CURRENCY.
   */
  static async finalizeCardSale(paymentId: string): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ peachPaymentId: paymentId });
    if (!sale) throw new Error('Sale not found for payment id');

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const { code, amount, currency } = await this.peachClient.getPaymentStatus(paymentId);
    const outcome = classifyResultCode(code || '');

    if (outcome === 'pending') return { status: 'pending' };

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // success — verify the EXACT amount + currency Peach reports before minting.
    // Peach returns amount as a string (e.g. "50.00"); convert to Number for comparison.
    const expectedCurrency = process.env['CARD_CURRENCY'] || 'ZAR';
    // Verify against what we actually charged (face + service fee). Fall back to
    // totalAmount for pre-service-fee sales that have no amountCharged.
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(amount);
    if (
      !Number.isFinite(confirmedAmount) ||
      confirmedAmount !== expectedAmount ||
      currency !== expectedCurrency
    ) {
      console.error('[card finalize] amount/currency mismatch — refusing to mint', {
        paymentId,
        expected: { amount: expectedAmount, currency: expectedCurrency },
        confirmed: { amount, currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // Atomically CLAIM the sale so concurrent poll + webhook can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' }; // someone else already finalized

    // Mint tickets, confirm reservation (reserved→sold), best-effort SMS
    const event = await Event.findById(sale.eventId);
    // Mints from the sale's own composition snapshot, so every ticket carries
    // ITS tier's name and the price the buyer actually agreed to. If any of
    // this fails, fulfilClaimedSale releases the claim we just took so the
    // sale can be retried rather than stranded COMPLETED with no tickets.
    const tickets: ITicket[] = await this.fulfilClaimedSale(sale, claimed);

    if (event) {
      const summaries = tickets.map(t => ({
        ticketId: t.ticketId,
        eventName: event.name,
        eventDate: event.eventDate.toISOString(),
        startTime: event.startTime?.toISOString(),
        venue: event.venue,
      }));
      if (sale.customerPhone) {
        SmsService.sendTicketConfirmation(sale.customerPhone, summaries)
          .catch(err => console.error('[SMS] card confirmation threw', err));
      }
      if (sale.customerEmail) {
        EmailService.sendTicketConfirmation(sale.customerEmail, summaries)
          .catch(err => console.error('[Email] card confirmation threw', err));
      }
    }

    await this.autoFollowOrganizerForSale(claimed);

    return { status: 'completed' };
  }

  /**
   * Reconciliation backstop: finalise Peach card sales that are still PENDING
   * despite the buyer having (possibly) paid — i.e. the return endpoint, the
   * webhook AND the SPA poll all missed. Runs on an interval; asks Peach for
   * each sale's true status via finalizeCardSale (success→mint, rejected→
   * release+fail, still-pending→left untouched). finalizeCardSale is idempotent
   * and pending-safe, so re-running is harmless.
   *
   * `olderThanMs` skips brand-new sales where the buyer is still on the hosted
   * page (avoids hammering Peach); the 2-min default sits far inside the 15-min
   * CARD_TTL_MS reservation hold, so paid sales are recovered long before the
   * reservation-expiry sweep would fail them.
   */
  static async reconcilePendingCardSales(olderThanMs = 2 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.PEACH_CARD,
      paymentStatus: PaymentStatus.PENDING,
      peachPaymentId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(50);

    let finalized = 0;
    for (const sale of stuck) {
      try {
        const r = await this.finalizeCardSale(sale.peachPaymentId as string);
        if (r.status !== 'pending') finalized++;
      } catch (err) {
        console.error(`[card-reconcile] failed for sale ${sale.saleId}`, err);
      }
    }
    if (finalized > 0) console.log(`[card-reconcile] finalised ${finalized}/${stuck.length} stuck card sale(s)`);
    return finalized;
  }

  /**
   * Reconciliation backstop for MTN MoMo, and the ONLY thing that resolves a
   * lapsed MoMo sale now that ReservationService.sweepExpired no longer fails
   * one on a timer. Mirrors reconcilePendingCardSales: asks MTN via
   * finalizeMomoSale (SUCCESSFUL→mint, FAILED→release+fail, PENDING→untouched),
   * which is idempotent and pending-safe, so re-running is harmless. It mints a
   * settled debit even when the hold was already released — confirm() then
   * no-ops and only `sold` is incremented, so there is no double-decrement.
   *
   * Why MoMo needs this more than card does: MTN's callback is fire-and-forget
   * with no retry, and the buyer's poll dies the moment they close the tab. When
   * both miss there is no other listener. On 2026-09-08 a buyer polled 40 times
   * over two minutes, gave up, and MTN reported SUCCESSFUL afterwards — E308
   * debited, no ticket, and nothing in the system ever asked.
   *
   * `olderThanMs` skips brand-new sales where the payer is still entering their
   * PIN. `maxPendingMs` is the safety net at the other end: a sale MTN STILL
   * reports non-successful after this long is abandoned and loud-failed, so
   * removing the sweep's verdict cannot leave sales PENDING forever. That fail
   * is safe because finalizeMomoSale has just confirmed, on this same pass, that
   * MTN does not consider it successful — a verdict from the processor, not a clock.
   */
  static async reconcilePendingMomoSales(
    olderThanMs = 60_000,
    maxPendingMs = 60 * 60_000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.PENDING,
      momoReferenceId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(50);

    let finalized = 0;
    for (const sale of stuck) {
      try {
        const r = await this.finalizeMomoSale(sale.momoReferenceId as string);
        if (r.status !== 'pending') { finalized++; continue; }

        const ageMs = Date.now() - new Date((sale as any).createdAt).getTime();
        if (ageMs > maxPendingMs) {
          console.warn('[momo-reconcile] abandoned past max pending window — failing', {
            saleId: sale.saleId,
            referenceId: sale.momoReferenceId,
            ageMs,
          });
          await ReservationService.release(sale._id.toString());
          await TicketSale.updateOne(
            { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
            { $set: { paymentStatus: PaymentStatus.FAILED, momoFailureReason: 'RECONCILE_TIMEOUT' } },
          );
        }
      } catch (err) {
        console.error(`[momo-reconcile] failed for sale ${sale.saleId}`, err);
      }
    }
    if (finalized > 0) console.log(`[momo-reconcile] finalised ${finalized}/${stuck.length} stuck momo sale(s)`);
    return finalized;
  }

  /**
   * Finalize a DeltaPay hosted-checkout sale identified by its session ID. Idempotent.
   *
   * - Sale not PENDING → return current status immediately (no re-mint).
   * - Ask DeltaPay for the AUTHORITATIVE outcome via verify-return. The buyer's
   *   return redirect is never proof of payment — they can close the tab, lose
   *   connectivity, or hit the return URL by hand.
   * - pending/processing (and any UNRECOGNISED status) → return pending, hold untouched.
   * - failed/expired/cancelled → release the hold + mark FAILED.
   * - succeeded → AMOUNT GUARD: the amount DeltaPay reports must equal what we
   *   charged (amountCharged, falling back to totalAmount for pre-service-fee
   *   rows). Mismatch → log loudly, release, fail, no mint. No currency check:
   *   DeltaPay is SZL-only and returns no currency field.
   * - ATOMIC claim via findOneAndUpdate({_id, paymentStatus: PENDING}) so a
   *   concurrent return + callback + poll cannot double-mint. Then mint tickets,
   *   confirm the reservation (reserved→sold), update sold counts, best-effort SMS.
   *
   * Mirrors finalizeCardSale; differences: lookup by deltapaySessionId and the
   * status comes from a plain enum rather than a provider result code.
   */
  static async finalizeDeltapaySale(
    sessionId: string
  ): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ deltapaySessionId: sessionId });
    if (!sale) throw new Error('Sale not found for checkout session id');

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const verified = await this.deltapayClient.verifySession(sessionId);
    const outcome = classifySessionStatus(verified.status);

    if (outcome === 'pending') return { status: 'pending' };

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // succeeded — verify the EXACT amount DeltaPay reports before minting.
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(verified.amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== expectedAmount) {
      console.error('[deltapay finalize] amount mismatch — refusing to mint', {
        sessionId,
        expected: expectedAmount,
        confirmed: verified.amount,
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // Atomically CLAIM the sale so concurrent return + callback + poll can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' }; // someone else already finalized

    // Mint tickets, confirm reservation (reserved→sold), best-effort SMS
    const event = await Event.findById(sale.eventId);
    // Mints from the sale's own composition snapshot, so every ticket carries
    // ITS tier's name and the price the buyer actually agreed to. If any of
    // this fails, fulfilClaimedSale releases the claim we just took so the
    // sale can be retried rather than stranded COMPLETED with no tickets.
    const tickets: ITicket[] = await this.fulfilClaimedSale(sale, claimed);

    if (event) {
      const summaries = tickets.map(t => ({
        ticketId: t.ticketId,
        eventName: event.name,
        eventDate: event.eventDate.toISOString(),
        startTime: event.startTime?.toISOString(),
        venue: event.venue,
      }));
      if (sale.customerPhone) {
        SmsService.sendTicketConfirmation(sale.customerPhone, summaries)
          .catch(err => console.error('[SMS] deltapay confirmation threw', err));
      }
      if (sale.customerEmail) {
        EmailService.sendTicketConfirmation(sale.customerEmail, summaries)
          .catch(err => console.error('[Email] deltapay confirmation threw', err));
      }
    }

    await this.autoFollowOrganizerForSale(claimed);

    return { status: 'completed' };
  }

  /**
   * Reconciliation backstop: finalise DeltaPay sales still PENDING despite the
   * buyer having (possibly) paid — i.e. the return endpoint, the session
   * callback AND the SPA poll all missed. Mirrors reconcilePendingCardSales.
   *
   * `olderThanMs` skips brand-new sales where the buyer is still on the hosted
   * page; the 2-min default sits far inside the 12-min DELTAPAY_TTL_MS hold, so
   * a paid sale is recovered long before the reservation-expiry sweep fails it.
   */
  static async reconcilePendingDeltapaySales(olderThanMs = 2 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.DELTAPAY,
      paymentStatus: PaymentStatus.PENDING,
      deltapaySessionId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(50);

    let finalized = 0;
    for (const sale of stuck) {
      try {
        const r = await this.finalizeDeltapaySale(sale.deltapaySessionId as string);
        if (r.status !== 'pending') finalized++;
      } catch (err) {
        console.error(`[deltapay-reconcile] failed for sale ${sale.saleId}`, err);
      }
    }
    if (finalized > 0) {
      console.log(`[deltapay-reconcile] finalised ${finalized}/${stuck.length} stuck DeltaPay sale(s)`);
    }
    return finalized;
  }

  /**
   * Initiate an async Yoco hosted-checkout purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Create the Yoco checkout — on failure, release reservation + fail sale + rethrow.
   *
   * Mirrors initiateDeltapayPurchase; differences: paymentMethod = YOCO, the
   * provider call is yocoClient.createCheckout, and Yoco takes THREE distinct
   * return URLs (success / cancel / failure) rather than one.
   */
  static async initiateYocoPurchase(p: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — persisted on the
    // PENDING sale so finalizeYocoSale can stamp it onto the minted tickets.
    customerEmail?: string;
    buyerId?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ checkoutId: string; redirectUrl: string; saleId: string; expiresAt: Date }> {
    if (!this.yocoClient.isConfigured()) throw new Error('Yoco is not available');

    // Checked up-front, BEFORE any sale row or inventory hold exists — a throw
    // after the reserve would strand held tickets until the expiry sweep.
    const returnUrl = process.env['YOCO_RETURN_URL'];
    if (!returnUrl) throw new Error('YOCO_RETURN_URL is not configured');

    const cfg = await PaymentConfigService.get();
    if (!cfg.yocoEnabled) throw new Error('Yoco is not available');


    // Attribution is resolved FIRST because resolveCart needs the channel to
    // decide whether a buyer service fee applies at all (ONLINE only).
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);

    // One call replaces the availability check, price maths, event load,
    // ticketing guard, restrictToMethod guard and fee computation this rail
    // used to carry itself — and adds the per-account cap across the cart.
    const cart = await resolveCart({
      eventId: p.eventId,
      items: p.items,
      method: PaymentMethod.YOCO,
      buyerId: p.buyerId,
      phone: p.customerPhone,
      channel,
    });
    const event = cart.event;
    const totalAmount = cart.faceTotal;
    const { serviceFeeAmount, amountCharged, absorbedServiceFeeAmount } = cart;
    // Attribution tier — resolveCart guarantees every line in a cart shares
    // one owner, so the first line speaks for all of them.
    const tt = cart.lines[0]!.ticketType;
    // Composition snapshot the finalizer mints from (see TicketSale.lines).
    const saleLines = cart.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      ticketTypeName: l.ticketType.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    }));

    // Attribution: mirror initiateDeltapayPurchase defaults exactly.
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Service fee — ONLINE checkout only (reseller/POS stay at face). Computed
    // BEFORE the economic snapshot because on an event whose organizer absorbs
    // the fee, the buyer is charged face and the fee becomes a deduction from
    // organizerProceeds — so the snapshot below needs the amount.

    // Immutable economic snapshot — Yoco is electronic so custody derives to 'carrot'.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.YOCO,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
      displayCurrency: event.currency ?? 'SZL',
      absorbedServiceFeeAmount,
    });
    const saleResellerId = resolveSaleResellerId(tt, p.resellerId ? String(p.resellerId) : undefined);
    const resellerAttribution = {
      ...(saleResellerId ? { resellerId: saleResellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      ...(tt.isAllocation ? { isAllocation: true } : {}),
    };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: cart.totalQuantity,
      lines: saleLines,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      totalAmount,
      paymentMethod: PaymentMethod.YOCO,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      saleId: sale._id.toString(),
      ttlMs: this.YOCO_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Create the Yoco checkout; on failure release + fail + rethrow
    try {
      // Thread OUR reference through each return URL so the return handler can
      // tell which sale the buyer came back from.
      //
      // This is a LOOKUP HINT ONLY — never proof of anything. Unlike the Peach
      // and DeltaPay return handlers, this one does NOT finalise: Yoco offers no
      // status-query endpoint, so the ONLY thing that can move a sale to
      // COMPLETED is a signature-verified webhook. A forged or guessed ref on
      // the return URL therefore grants nothing beyond a status read.
      const withRef = (outcome: 'success' | 'cancel' | 'failure') => {
        const u = new URL(returnUrl);
        u.searchParams.set('ref', sale.saleId);
        u.searchParams.set('outcome', outcome);
        return u.toString();
      };

      const checkout = await this.yocoClient.createCheckout({
        amount: amountCharged,
        // Yoco is ZAR-only; Carrot prices in SZL at 1:1 (same basis as Peach).
        currency: settlementCurrencyForMethod(PaymentMethod.YOCO),
        successUrl: withRef('success'),
        cancelUrl: withRef('cancel'),
        failureUrl: withRef('failure'),
        metadata: { saleRef: sale.saleId, eventId: String(p.eventId) },
        externalId: sale.saleId,
        // Stable per sale: a retried initiate returns Yoco's EXISTING checkout
        // rather than creating a second one the buyer could pay twice.
        idempotencyKey: sale.saleId,
      });

      sale.yocoCheckoutId = checkout.id;
      await sale.save();
      return {
        checkoutId: checkout.id,
        redirectUrl: checkout.redirectUrl,
        saleId: sale._id.toString(),
        expiresAt,
      };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a Yoco sale by its checkout ID. Returns null if not found. Never throws.
   */
  static async getYocoSaleByCheckoutId(
    checkoutId: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ yocoCheckoutId: checkoutId });
  }

  /**
   * Look up a Yoco sale by OUR OWN reference (sale.saleId), for the return
   * redirect. A lookup hint only — see initiateYocoPurchase.
   */
  static async getYocoSaleByRef(
    saleRef: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ saleId: saleRef, paymentMethod: PaymentMethod.YOCO });
  }

  /**
   * Finalize a Yoco sale from an ALREADY-VERIFIED webhook payload. Idempotent.
   *
   * WHY THE SIGNATURE DIFFERS FROM ITS PEACH/DELTAPAY TWINS: Yoco publishes no
   * status-query endpoint, so there is nothing to ask "is this paid?". The
   * caller (YocoController.webhook) MUST have already checked the Standard-
   * Webhooks signature; this method then treats the payload as authoritative.
   * Never call it with an unverified body — that is the whole security boundary.
   *
   * - Sale not PENDING → return current status immediately (no re-mint).
   * - Unknown event type → 'pending', hold left intact (never mints).
   * - payment.failed → release + fail.
   * - payment.succeeded → AMOUNT/CURRENCY GUARD (cents, against
   *   `amountCharged ?? totalAmount`) → ATOMIC claim → mint.
   */
  static async finalizeYocoSale(
    checkoutId: string,
    event: { type: string; amountCents: number; currency: string }
  ): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ yocoCheckoutId: checkoutId });
    if (!sale) throw new Error('Sale not found for checkout id');

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const outcome = classifyEventType(event.type);

    // 'ignore' covers refund events and anything Yoco adds later. Leaving the
    // sale PENDING (rather than failing it) keeps the inventory hold alive so a
    // genuine payment.succeeded arriving afterwards can still mint.
    if (outcome === 'ignore') return { status: 'pending' };

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // succeeded — verify the EXACT amount + currency Yoco reports before minting.
    // Compare in CENTS: Yoco reports integer cents, and comparing integers avoids
    // the float-equality trap that `50.00 !== 49.999999` would otherwise create.
    const expectedCents = toCents(sale.amountCharged ?? sale.totalAmount);
    const expectedCurrency = settlementCurrencyForMethod(PaymentMethod.YOCO);
    if (
      !Number.isFinite(event.amountCents) ||
      event.amountCents !== expectedCents ||
      event.currency !== expectedCurrency
    ) {
      console.error('[yoco finalize] amount/currency mismatch — refusing to mint', {
        checkoutId,
        expected: { amountCents: expectedCents, currency: expectedCurrency },
        confirmed: { amountCents: event.amountCents, currency: event.currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // Atomically CLAIM the sale so a retried webhook + the poll can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' }; // someone else already finalized

    // Mint tickets, confirm reservation (reserved→sold), best-effort SMS/email
    const eventDoc = await Event.findById(sale.eventId);
    // Mints from the sale's own composition snapshot, so every ticket carries
    // ITS tier's name and the price the buyer actually agreed to. If any of
    // this fails, fulfilClaimedSale releases the claim we just took so the
    // sale can be retried rather than stranded COMPLETED with no tickets.
    const tickets: ITicket[] = await this.fulfilClaimedSale(sale, claimed);

    if (eventDoc) {
      const summaries = tickets.map(t => ({
        ticketId: t.ticketId,
        eventName: eventDoc.name,
        eventDate: eventDoc.eventDate.toISOString(),
        startTime: eventDoc.startTime?.toISOString(),
        venue: eventDoc.venue,
      }));
      if (sale.customerPhone) {
        SmsService.sendTicketConfirmation(sale.customerPhone, summaries)
          .catch(err => console.error('[SMS] yoco confirmation threw', err));
      }
      if (sale.customerEmail) {
        EmailService.sendTicketConfirmation(sale.customerEmail, summaries)
          .catch(err => console.error('[Email] yoco confirmation threw', err));
      }
    }

    await this.autoFollowOrganizerForSale(claimed);

    return { status: 'completed' };
  }

  /**
   * Visibility backstop for stuck Yoco sales.
   *
   * WHY THIS IS A REPORTER, NOT A RECONCILER: reconcilePendingCardSales and
   * reconcilePendingDeltapaySales RESOLVE stuck sales by asking the provider for
   * the true status. Yoco publishes no status-query endpoint, so there is
   * nothing to ask — the signed webhook is the only source of truth. Rather
   * than guess (failing a paid sale loses the buyer their ticket; completing an
   * unpaid one mints for free), this job makes the sale LOUD for manual recovery
   * and changes nothing.
   *
   * It pairs with the ReservationService.sweepExpired carve-out, which leaves
   * Yoco sales PENDING precisely so a late webhook can still mint them.
   */
  static async reportStuckYocoSales(olderThanMs = 20 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.YOCO,
      paymentStatus: PaymentStatus.PENDING,
      yocoCheckoutId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(50);

    for (const sale of stuck) {
      console.error(
        '[yoco-stuck] PENDING past threshold — no webhook received; needs manual check',
        {
          saleId: sale.saleId,
          checkoutId: sale.yocoCheckoutId,
          amountCharged: sale.amountCharged ?? sale.totalAmount,
          createdAt: sale.createdAt,
        }
      );
    }
    if (stuck.length > 0) {
      console.error(`[yoco-stuck] ${stuck.length} Yoco sale(s) awaiting a webhook that never arrived`);
    }
    return stuck.length;
  }

  /**
   * Initiate an async YeboPay hosted-checkout purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Create the YeboPay checkout — on failure, release reservation + fail sale + rethrow.
   *
   * Mirrors initiateDeltapayPurchase; differences: paymentMethod = YEBOPAY, the
   * provider call is yebopayClient.createCheckout, and YeboPay takes THREE distinct
   * return URLs (success / cancel / failure) rather than one.
   */
  static async initiateYeboPayPurchase(p: {
    eventId: string;
    /** One entry per tier. A single-tier purchase is a one-element array. */
    items: CartLine[];
    customerPhone?: string;
    customerName?: string;
    // Buyer identity, when purchasing while logged in — persisted on the
    // PENDING sale so finalizeYeboPaySale can stamp it onto the minted tickets.
    customerEmail?: string;
    buyerId?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ checkoutId: string; redirectUrl: string; saleId: string; expiresAt: Date }> {
    if (!this.yebopayClient.isConfigured()) throw new Error('YeboPay is not available');

    // Checked up-front, BEFORE any sale row or inventory hold exists — a throw
    // after the reserve would strand held tickets until the expiry sweep.
    const returnUrl = process.env['YEBOPAY_RETURN_URL'];
    if (!returnUrl) throw new Error('YEBOPAY_RETURN_URL is not configured');

    const cfg = await PaymentConfigService.get();
    if (!cfg.yebopayEnabled) throw new Error('YeboPay is not available');


    // Attribution is resolved FIRST because resolveCart needs the channel to
    // decide whether a buyer service fee applies at all (ONLINE only).
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);

    // One call replaces the availability check, price maths, event load,
    // ticketing guard, restrictToMethod guard and fee computation this rail
    // used to carry itself — and adds the per-account cap across the cart.
    const cart = await resolveCart({
      eventId: p.eventId,
      items: p.items,
      method: PaymentMethod.YEBOPAY,
      buyerId: p.buyerId,
      phone: p.customerPhone,
      channel,
    });
    const event = cart.event;
    const totalAmount = cart.faceTotal;
    const { serviceFeeAmount, amountCharged, absorbedServiceFeeAmount } = cart;
    // Attribution tier — resolveCart guarantees every line in a cart shares
    // one owner, so the first line speaks for all of them.
    const tt = cart.lines[0]!.ticketType;
    // Composition snapshot the finalizer mints from (see TicketSale.lines).
    const saleLines = cart.lines.map((l) => ({
      ticketTypeId: l.ticketTypeId,
      ticketTypeName: l.ticketType.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    }));

    // Attribution: mirror initiateDeltapayPurchase defaults exactly.
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Service fee — ONLINE checkout only (reseller/POS stay at face). Computed
    // BEFORE the economic snapshot because on an event whose organizer absorbs
    // the fee, the buyer is charged face and the fee becomes a deduction from
    // organizerProceeds — so the snapshot below needs the amount.

    // Immutable economic snapshot — YeboPay is electronic so custody derives to 'carrot'.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.YEBOPAY,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
      displayCurrency: event.currency ?? 'SZL',
      absorbedServiceFeeAmount,
    });
    const saleResellerId = resolveSaleResellerId(tt, p.resellerId ? String(p.resellerId) : undefined);
    const resellerAttribution = {
      ...(saleResellerId ? { resellerId: saleResellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
      ...(tt.isAllocation ? { isAllocation: true } : {}),
    };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: cart.totalQuantity,
      lines: saleLines,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      ...(p.customerEmail ? { customerEmail: p.customerEmail.toLowerCase() } : {}),
      ...(p.buyerId ? { buyerId: p.buyerId } : {}),
      totalAmount,
      paymentMethod: PaymentMethod.YEBOPAY,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      lines: cart.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity })),
      saleId: sale._id.toString(),
      ttlMs: this.YEBOPAY_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Create the YeboPay checkout; on failure release + fail + rethrow
    try {
      // Thread OUR reference through each return URL so the return handler can
      // tell which sale the buyer came back from.
      //
      // This is a LOOKUP HINT ONLY — never proof of anything. Unlike the Peach
      // and DeltaPay return handlers, this one does NOT finalise: YeboPay offers no
      // status-query endpoint, so the ONLY thing that can move a sale to
      // COMPLETED is a signature-verified webhook. A forged or guessed ref on
      // the return URL therefore grants nothing beyond a status read.
      const withRef = (outcome: 'success' | 'cancel' | 'failure') => {
        const u = new URL(returnUrl);
        u.searchParams.set('ref', sale.saleId);
        u.searchParams.set('outcome', outcome);
        return u.toString();
      };

      const checkout = await this.yebopayClient.createCheckout({
        amount: amountCharged,
        // SZL, not ZAR. Unlike Peach and Yoco, YeboPay accepts Emalangeni and
        // applies the 1:1 Common Monetary Area peg itself when it reaches the
        // card processor — so Carrot never does the conversion.
        currency: settlementCurrencyForMethod(PaymentMethod.YEBOPAY),
        successUrl: withRef('success'),
        cancelUrl: withRef('cancel'),
        description: `Carrot Tickets — sale ${sale.saleId}`,
        ...(p.customerEmail ? { email: p.customerEmail } : {}),
        // saleRef is how the webhook and the return handler find this sale.
        // NOTE: YeboPay does NOT honour Idempotency-Key on checkout creation
        // (only on /v1/charges), so unlike the Yoco rail there is no provider
        // -side dedupe. The PENDING sale row is the dedupe anchor: initiate is
        // only reached once per sale, and a retry creates a NEW sale.
        metadata: { saleRef: sale.saleId, eventId: String(p.eventId) },
      });

      sale.yebopayCheckoutId = checkout.id;
      await sale.save();
      return {
        checkoutId: checkout.id,
        redirectUrl: checkout.hostedUrl,
        saleId: sale._id.toString(),
        expiresAt,
      };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a YeboPay sale by its checkout ID. Returns null if not found. Never throws.
   */
  static async getYeboPaySaleByCheckoutId(
    checkoutId: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ yebopayCheckoutId: checkoutId });
  }

  /**
   * Look up a YeboPay sale by OUR OWN reference (sale.saleId), for the return
   * redirect. A lookup hint only — see initiateYeboPayPurchase.
   */
  static async getYeboPaySaleByRef(
    saleRef: string
  ): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ saleId: saleRef, paymentMethod: PaymentMethod.YEBOPAY });
  }

  /**
   * Finalize a YeboPay sale from an ALREADY-VERIFIED webhook payload. Idempotent.
   *
   * WHY THE SIGNATURE DIFFERS FROM ITS PEACH/DELTAPAY TWINS: YeboPay publishes no
   * status-query endpoint, so there is nothing to ask "is this paid?". The
   * caller (YeboPayController.webhook) MUST have already checked the Standard-
   * Webhooks signature; this method then treats the payload as authoritative.
   * Never call it with an unverified body — that is the whole security boundary.
   *
   * - Sale not PENDING → return current status immediately (no re-mint).
   * - Unknown event type → 'pending', hold left intact (never mints).
   * - payment.failed → release + fail.
   * - payment.succeeded → AMOUNT/CURRENCY GUARD (cents, against
   *   `amountCharged ?? totalAmount`) → ATOMIC claim → mint.
   */
  static async finalizeYeboPaySale(
    checkoutId: string,
    // `amount` is YeboPay's DECIMAL string/number ("150.0000"), not cents.
    event: { type: string; amount: string | number; currency: string }
  ): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ yebopayCheckoutId: checkoutId });
    if (!sale) throw new Error('Sale not found for checkout id');

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const outcome = classifyYeboPayEventType(event.type);

    // 'ignore' covers refund events and anything YeboPay adds later. Leaving the
    // sale PENDING (rather than failing it) keeps the inventory hold alive so a
    // genuine payment.succeeded arriving afterwards can still mint.
    if (outcome === 'ignore') return { status: 'pending' };

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // succeeded — verify the EXACT amount + currency YeboPay reports before minting.
    // YeboPay reports DECIMAL amounts ("150.0000"), unlike Yoco's integer cents,
    // so normalise BOTH sides to integer cents before comparing: float equality
    // on 150.0000 vs 150 is a trap worth designing out, and this check is the
    // last thing between a tampered amount and a minted ticket.
    const expectedCents = toCents(sale.amountCharged ?? sale.totalAmount);
    const confirmedAmount = Number(event.amount);
    const confirmedCents = Number.isFinite(confirmedAmount) ? toCents(confirmedAmount) : NaN;
    const expectedCurrency = settlementCurrencyForMethod(PaymentMethod.YEBOPAY);
    if (
      !Number.isFinite(confirmedCents) ||
      confirmedCents !== expectedCents ||
      event.currency !== expectedCurrency
    ) {
      console.error('[yebopay finalize] amount/currency mismatch — refusing to mint', {
        checkoutId,
        expected: { amountCents: expectedCents, currency: expectedCurrency },
        confirmed: { amount: event.amount, currency: event.currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // Atomically CLAIM the sale so a retried webhook + the poll can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' }; // someone else already finalized

    // Mint tickets, confirm reservation (reserved→sold), best-effort SMS/email
    const eventDoc = await Event.findById(sale.eventId);
    // Mints from the sale's own composition snapshot, so every ticket carries
    // ITS tier's name and the price the buyer actually agreed to. If any of
    // this fails, fulfilClaimedSale releases the claim we just took so the
    // sale can be retried rather than stranded COMPLETED with no tickets.
    const tickets: ITicket[] = await this.fulfilClaimedSale(sale, claimed);

    if (eventDoc) {
      const summaries = tickets.map(t => ({
        ticketId: t.ticketId,
        eventName: eventDoc.name,
        eventDate: eventDoc.eventDate.toISOString(),
        startTime: eventDoc.startTime?.toISOString(),
        venue: eventDoc.venue,
      }));
      if (sale.customerPhone) {
        SmsService.sendTicketConfirmation(sale.customerPhone, summaries)
          .catch(err => console.error('[SMS] yebopay confirmation threw', err));
      }
      if (sale.customerEmail) {
        EmailService.sendTicketConfirmation(sale.customerEmail, summaries)
          .catch(err => console.error('[Email] yebopay confirmation threw', err));
      }
    }

    await this.autoFollowOrganizerForSale(claimed);

    return { status: 'completed' };
  }

  /**
   * Reconcile PENDING YeboPay sales by ASKING YeboPay, then finalising.
   *
   * This is the rail's real advantage over Yoco: YeboPay publishes
   * `GET /v1/checkouts/:id`, so a sale whose webhook never arrived can still be
   * resolved instead of merely reported. That matters because YeboPay webhook
   * delivery has NO automatic retry — a single failed POST would otherwise
   * strand a paid sale until a human noticed.
   *
   * Runs ahead of the reservation-expiry sweep so a paid sale is minted, never
   * failed. Pairs with the ReservationService carve-out that leaves YeboPay
   * sales PENDING precisely so a late confirmation can still mint them.
   */
  static async reconcilePendingYeboPaySales(olderThanMs = 90_000): Promise<{ minted: number; failed: number; pending: number }> {
    if (!this.yebopayClient.isConfigured()) return { minted: 0, failed: 0, pending: 0 };

    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.YEBOPAY,
      paymentStatus: PaymentStatus.PENDING,
      yebopayCheckoutId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(100);

    let minted = 0, failed = 0, pending = 0;
    for (const sale of stuck) {
      // One bad row must not stop the batch — the next sale may be a paid one
      // waiting to mint. Never swallowed silently.
      try {
        const remote = await this.yebopayClient.getCheckout(sale.yebopayCheckoutId!);
        const outcome = classifyCheckoutStatus(remote.status);
        if (outcome === 'pending') { pending += 1; continue; }

        // Route through the SAME finalizer the webhook uses, so the amount and
        // currency verification runs here too. A reconcile path that trusted the
        // status alone would be a way around that check.
        const res = await this.finalizeYeboPaySale(sale.yebopayCheckoutId!, {
          type: outcome === 'success' ? 'checkout.completed' : 'checkout.expired',
          amount: remote.amount ?? 0,
          currency: remote.currency ?? settlementCurrencyForMethod(PaymentMethod.YEBOPAY),
        });
        if (res.status === 'completed') minted += 1;
        else if (res.status === 'failed') failed += 1;
        else pending += 1;
      } catch (err) {
        console.error('[yebopay reconcile] could not resolve sale', {
          saleId: sale.saleId,
          checkoutId: sale.yebopayCheckoutId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (minted || failed) {
      console.log('[yebopay reconcile] resolved', { minted, failed, pending, scanned: stuck.length });
    }
    return { minted, failed, pending };
  }
}
