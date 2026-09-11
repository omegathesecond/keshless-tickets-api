import { Reseller } from '@models/reseller.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { TicketService } from '@services/ticket.service';
import { SmsService } from '@services/sms.service';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import type { CartLine } from '@interfaces/cart.interface';

type ResellerPaymentMethod = 'cash' | 'mtn_momo' | 'keshless_wallet';

interface CreateSaleParams {
  operatorId: string;
  resellerId: string;
  hubId: string;
  eventId: string;
  /**
   * One entry per tier. A single-tier ring-up is a one-element array.
   *
   * An allocation block's remaining stock is `tier.quantity - tier.sold` on
   * the tier itself (AllocationService is a read-only view of exactly that),
   * so the per-line availability check resolveCart already performs IS the
   * allocation check — there is no second ledger to reconcile here.
   */
  items: CartLine[];
  paymentMethod: ResellerPaymentMethod;
  customerName?: string;
  customerPhone?: string;
  // Buyer's MoMo number for the mtn_momo lane (the till collects it). Falls back
  // to customerPhone when omitted.
  momoPhone?: string;
  keshlessCardNumber?: string;
  keshlessPin?: string;
}

// Synchronous (cash / keshless_wallet) result: tickets minted immediately.
interface CompletedSaleResult {
  saleId: string;
  status: 'completed' | 'failed';
  tickets: any[];
  message?: string;
}

// Asynchronous (mtn_momo) result: PENDING sale awaiting MTN confirmation. No
// tickets yet — the caller polls/finalizes via the referenceId.
interface PendingSaleResult {
  saleId: string;
  status: 'pending';
  referenceId: string;
  expiresAt: Date;
}

type CreateSaleResult = CompletedSaleResult | PendingSaleResult;

// Maps the ResellerPaymentMethod to the PaymentConfig toggle key.
const METHOD_TOGGLE: Record<ResellerPaymentMethod, keyof Awaited<ReturnType<typeof PaymentConfigService.get>>> = {
  cash: 'cashEnabled',
  mtn_momo: 'mtnMomoEnabled',
  keshless_wallet: 'keshlessWalletEnabled',
};

// Maps the string method to the PaymentMethod enum used by TicketService.
const METHOD_ENUM: Record<ResellerPaymentMethod, PaymentMethod> = {
  cash: PaymentMethod.CASH,
  mtn_momo: PaymentMethod.MTN_MOMO,
  keshless_wallet: PaymentMethod.KESHLESS_WALLET,
};

export class ResellerSaleService {
  /**
   * Reseller POS sale path.
   *
   * Guards:
   * 1. Payment method must be enabled in PaymentConfig.
   * 2. Reseller must exist and not be suspended.
   * 3. Event must exist and be published (to resolve vendorId).
   *
   * All capacity, payment processing, ticket minting, and economic snapshot
   * work is delegated to TicketService.sellTickets — do NOT duplicate it here.
   */
  static async createSale(params: CreateSaleParams): Promise<CreateSaleResult> {
    const cfg = await PaymentConfigService.get();

    // Guard 1: payment method toggle
    const toggleKey = METHOD_TOGGLE[params.paymentMethod];
    if (!cfg[toggleKey]) {
      throw new Error('Payment method not available');
    }

    // Guard 2: reseller must exist and be active
    const reseller = await Reseller.findById(params.resellerId);
    if (!reseller) {
      throw new Error(`Reseller not found: ${params.resellerId}`);
    }
    if (reseller.status === 'suspended') {
      throw new Error(`Reseller is suspended: ${params.resellerId}`);
    }

    // Resolve commission: reseller-specific takes precedence over platform default.
    const resellerCommissionPercent =
      reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;

    // Guard 3: event must exist and be published (gives us vendorId)
    const event = await Event.findOne({ _id: params.eventId, status: EventStatus.PUBLISHED });
    if (!event) {
      throw new Error(`Event not found or not published: ${params.eventId}`);
    }

    // MTN MoMo is ASYNC: route to the initiate path (PENDING sale + requestToPay),
    // NOT the synchronous sellTickets charge path (which throws for MoMo). The
    // till finalizes later via finalizeSale(referenceId).
    if (params.paymentMethod === 'mtn_momo') {
      // Require a buyer phone — momoPhone preferred, customerPhone as fallback.
      // No silent fallback: a missing number is a hard 4xx-worthy error.
      const momoPhone = params.momoPhone ?? params.customerPhone;
      if (!momoPhone) {
        throw new Error('A buyer MoMo phone number is required for MTN MoMo sales');
      }

      const { saleId, referenceId, expiresAt } = await TicketService.initiateMomoPurchase({
        eventId: params.eventId,
        items: params.items,
        customerName: params.customerName,
        customerPhone: params.customerPhone ?? momoPhone,
        momoPhone,
        vendorId: event.vendorId!.toString(),
        soldBy: params.operatorId,
        soldByType: 'reseller-operator',
        resellerId: params.resellerId,
        hubId: params.hubId,
        resellerCommissionPercent,
      });

      return { saleId, status: 'pending', referenceId, expiresAt };
    }

    const { sale, tickets, paymentMessage } = await TicketService.sellTickets({
      eventId: params.eventId,
      vendorId: event.vendorId!.toString(),
      lines: params.items,
      paymentMethod: METHOD_ENUM[params.paymentMethod],
      customerName: params.customerName,
      customerPhone: params.customerPhone,
      keshlessCardNumber: params.keshlessCardNumber,
      keshlessPin: params.keshlessPin,
      soldBy: params.operatorId,
      soldByType: 'reseller-operator',
      resellerId: params.resellerId,
      hubId: params.hubId,
      resellerCommissionPercent,
    });

    // cash / keshless_wallet are synchronous — only completed or failed here
    // (the async pending lane is handled in the mtn_momo branch above).
    const status: 'completed' | 'failed' =
      sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed';

    return {
      saleId: sale._id.toString(),
      status,
      tickets,
      ...(paymentMessage ? { message: paymentMessage } : {}),
    };
  }

  /**
   * Finalize a reseller MoMo sale by its MTN referenceId.
   *
   * Ownership isolation: a reseller may ONLY finalize a sale it owns. If the
   * sale's resellerId does not match the caller's resellerId we throw an
   * authorization error BEFORE consulting MTN — preventing one reseller from
   * driving another reseller's PENDING sale to completion.
   *
   * Delegates the actual status check + mint to TicketService.finalizeMomoSale
   * (idempotent). Throws not-found when the referenceId is unknown.
   */
  static async finalizeSale(
    referenceId: string,
    resellerId: string
  ): Promise<{ status: 'completed' | 'failed' | 'pending'; saleId: string; reason?: string }> {
    const sale = await TicketService.getMomoSaleByReference(referenceId);
    if (!sale) {
      throw new Error(`Sale not found for reference: ${referenceId}`);
    }

    // Security: ownership guard (scope isolation)
    if (sale.resellerId?.toString() !== resellerId) {
      throw new Error('Not authorized to finalize this sale');
    }

    const { status, reason } = await TicketService.finalizeMomoSale(referenceId);
    return { status, saleId: sale._id.toString(), reason };
  }

  /**
   * Manually (re)send the ticket confirmation SMS for a reseller sale.
   *
   * Reseller-INITIATED, so unlike the best-effort auto-send on the wallet/MoMo
   * paths this is NOT fire-and-forget: we return whether the gateway accepted
   * the message so the till can surface a failure (no silent success).
   *
   * Scope isolation: the sale must belong to the calling reseller.
   */
  static async sendSaleSms(
    saleId: string,
    resellerId: string,
  ): Promise<{ sent: boolean }> {
    const sale = await TicketSale.findById(saleId);
    if (!sale) {
      throw new Error(`Sale not found: ${saleId}`);
    }
    if (sale.resellerId?.toString() !== resellerId) {
      throw new Error('Not authorized to send SMS for this sale');
    }
    // Same send for both rails — only the ownership check above differs.
    return TicketService.sendSaleConfirmationSms(sale);
  }

  static async getOperatorSales(params: {
    operatorId: string;
    resellerId: string;
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{ sales: any[]; total: number; page: number; limit: number }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    const filter: any = {
      soldBy: params.operatorId,
      soldByType: 'ResellerOperator',
      resellerId: params.resellerId,
    };

    if (params.startDate || params.endDate) {
      filter.soldAt = {};
      if (params.startDate) filter.soldAt.$gte = params.startDate;
      if (params.endDate) filter.soldAt.$lte = params.endDate;
    }

    const [sales, total] = await Promise.all([
      TicketSale.find(filter)
        .populate('eventId', 'name venue eventDate')
        .sort({ soldAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TicketSale.countDocuments(filter),
    ]);

    return { sales, total, page, limit };
  }
}
