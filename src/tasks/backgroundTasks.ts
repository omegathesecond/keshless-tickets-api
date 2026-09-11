import { ReservationService } from '@services/reservation.service';
import { TicketService } from '@services/ticket.service';
import { EventReminderService } from '@services/eventReminder.service';
import { reconcileStuckUpdates, reconcileStuckStories } from '@services/transcode.client';
import { BookingService } from '@services/transport/booking.service';
import { MenuOrderService } from '@services/menuOrder.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { AccountActivityDigestService } from '@services/accountActivityDigest.service';
import { VoteNotificationService } from '@services/voteNotification.service';
import { ShareEarnService } from '@services/shareEarn.service';

// Start the reservation expiry sweep
const RESERVATION_SWEEP_MS = 60_000;

// Reconcile paid-but-stuck Peach card sales (return endpoint + webhook +
// poll all missed). Runs ahead of the 15-min reservation expiry so a paid
// sale is minted, never failed. See TicketService.reconcilePendingCardSales.
const CARD_RECONCILE_MS = 60_000;

// Reconcile paid-but-stuck DeltaPay sales (return redirect + session callback +
// poll all missed). Runs ahead of the 12-min reservation hold so a paid sale is
// minted, never failed. See TicketService.reconcilePendingDeltapaySales.
const DELTAPAY_RECONCILE_MS = 60_000;

// Reconcile paid-but-stuck MTN MoMo sales (fire-and-forget callback missed AND
// the buyer's poll stopped). Since ReservationService.sweepExpired no longer
// fails a queryable MoMo sale on a timer, this is the ONLY thing that resolves
// one — both to mint a late settlement and to loud-fail a truly abandoned sale.
// See TicketService.reconcilePendingMomoSales.
const MOMO_RECONCILE_MS = 60_000;

// Yoco: report (never resolve) sales stuck PENDING because no signed webhook
// arrived. Yoco has NO status-query endpoint, so unlike the card/DeltaPay
// reconcilers above this one cannot ask the provider what happened — it makes
// the sale loud for manual recovery instead. See
// TicketService.reportStuckYocoSales and the ReservationService.sweepExpired
// carve-out that keeps such sales PENDING.
const YOCO_STUCK_REPORT_MS = 300_000;

// YeboPay: RESOLVE (not merely report) sales stuck PENDING because no signed
// webhook arrived. YeboPay publishes GET /v1/checkouts/:id, so unlike Yoco this
// can ask and finalise. It runs on a short interval because YeboPay webhook
// delivery has no automatic retry — this sweep is the only thing behind a
// dropped POST, and the buyer's return handler.
const YEBOPAY_RECONCILE_MS = 60_000;

// Event reminders (spec §6): T-24h and day-of pushes for ticket holders.
const REMINDER_SWEEP_MS = 600_000;

// Discover feed: re-trigger or fail-loud-fail video updates stuck in
// 'processing' (transcoder crashed/never called back). See
// @services/transcode.client#reconcileStuckUpdates.
const UPDATE_RECONCILE_MS = 120_000;

// Stories: same sweep as above for video Stories stuck 'processing' (a
// crashed/never-dispatched transcode job). See
// @services/transcode.client#reconcileStuckStories.
const STORY_RECONCILE_MS = 120_000;

// Bus bookings: reconcile paid-but-stuck Peach card bookings (mirrors
// CARD_RECONCILE_MS above) + sweep expired PENDING bookings whose
// reservation hold lapsed (releases seat/GA capacity, marks FAILED/CANCELLED).
// See BookingService.reconcilePendingCardBookings / sweepExpiredBookings.
const BOOKING_CARD_RECONCILE_MS = 60_000;
const BOOKING_SWEEP_MS = 60_000;

// Menu preorders paid by MTN MoMo whose callback never arrived (the buyer
// approved on the handset and closed the tab, so the status poll stopped
// too). Same cadence as the ticket MoMo/card reconcilers; asks MTN and
// finalises through the same idempotent finaliser the poll uses. See
// MenuOrderService.reconcilePendingMomoOrders.
const MENU_MOMO_RECONCILE_MS = 60_000;

// Cashless ledger: run the three internal reconciliation checks (accounting
// identity, journal integrity, stored wallet balance vs journal) over every
// cashless event that ended in the last 7 days, and log at error level with
// the event id and the drifted wallet ids when anything does not reconcile.
// Report-only like the Yoco sweep — nothing is repaired. 15 minutes rather
// than 60s: checkWalletBalances aggregates the journal once per wallet, so
// this is the heaviest sweep here, and drift needs surfacing, not sub-minute
// latency. See ReconciliationService.sweepRecentCashlessEvents.
const CASHLESS_RECONCILE_MS = 900_000;

// My Account tab (Activity page): grouped push digest for profile/Story/post
// views — see AccountActivityDigestService.sweep. 30 minutes: frequent
// enough that "today" in the push copy stays true across a normal browsing
// session, coarse enough that a burst of views lands as one summary rather
// than one push per sweep tick.
const ACCOUNT_ACTIVITY_DIGEST_MS = 1_800_000;

// Vote: materialize questions once a Vote window opens + dispatch the
// spec §8 one-time "opened" notification and the one optional "closing soon"
// reminder. Same cadence as the event reminder sweep.
const VOTE_SWEEP_MS = 600_000;

// Share&Earn (spec §17): auto-close campaigns whose closing date has passed —
// stops accepting new referrals while preserving everything already earned.
// Same cadence as the event reminder/Vote sweeps.
const SHARE_EARN_SWEEP_MS = 600_000;

/**
 * Registers all periodic background sweeps (reservation expiry, card-sale
 * reconciliation, event reminders, stuck-update reconciliation) with their
 * existing intervals. Returns the interval handles so callers (tests,
 * graceful shutdown) can inspect or clear them.
 *
 * Behavior-preserving move out of src/app.ts — same functions, same
 * intervals, same error-logging; only the wiring moved.
 */
export function startBackgroundTasks(): NodeJS.Timeout[] {
  const handles: NodeJS.Timeout[] = [];

  handles.push(setInterval(() => {
    ReservationService.sweepExpired().catch(err => console.error('[reservation-sweep] error', err));
  }, RESERVATION_SWEEP_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingCardSales().catch(err => console.error('[card-reconcile] error', err));
  }, CARD_RECONCILE_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingDeltapaySales().catch(err => console.error('[deltapay-reconcile] error', err));
  }, DELTAPAY_RECONCILE_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingMomoSales().catch(err => console.error('[momo-reconcile] error', err));
  }, MOMO_RECONCILE_MS));

  handles.push(setInterval(() => {
    TicketService.reportStuckYocoSales().catch(err => console.error('[yoco-stuck] error', err));
  }, YOCO_STUCK_REPORT_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingYeboPaySales().catch(err => console.error('[yebopay-reconcile] error', err));
  }, YEBOPAY_RECONCILE_MS));

  handles.push(setInterval(() => {
    EventReminderService.sweep().catch((err) => console.error('[reminder-sweep] error', err));
  }, REMINDER_SWEEP_MS));

  handles.push(setInterval(() => {
    reconcileStuckUpdates().catch((e) => console.error('update reconcile sweep failed:', e?.message));
  }, UPDATE_RECONCILE_MS));

  handles.push(setInterval(() => {
    reconcileStuckStories().catch((e) => console.error('story reconcile sweep failed:', e?.message));
  }, STORY_RECONCILE_MS));

  handles.push(setInterval(() => {
    BookingService.reconcilePendingCardBookings().catch(err => console.error('[booking card-reconcile] error', err));
  }, BOOKING_CARD_RECONCILE_MS));

  handles.push(setInterval(() => {
    BookingService.sweepExpiredBookings().catch(err => console.error('[booking sweep] error', err));
  }, BOOKING_SWEEP_MS));

  handles.push(setInterval(() => {
    MenuOrderService.reconcilePendingMomoOrders().catch(err => console.error('[menu momo-reconcile] error', err));
  }, MENU_MOMO_RECONCILE_MS));

  handles.push(setInterval(() => {
    ReconciliationService.sweepRecentCashlessEvents().catch(err => console.error('[cashless-reconcile] error', err));
  }, CASHLESS_RECONCILE_MS));

  handles.push(setInterval(() => {
    AccountActivityDigestService.sweep().catch(err => console.error('[account-activity-digest] error', err));
  }, ACCOUNT_ACTIVITY_DIGEST_MS));

  handles.push(setInterval(() => {
    VoteNotificationService.sweep().catch((err) => console.error('[vote-sweep] error', err));
  }, VOTE_SWEEP_MS));

  handles.push(setInterval(() => {
    ShareEarnService.autoCloseExpiredCampaigns().catch((err) => console.error('[share-earn-sweep] error', err));
    ShareEarnService.notifyCampaignsClosingSoon().catch((err) => console.error('[share-earn-closing-soon] error', err));
  }, SHARE_EARN_SWEEP_MS));

  return handles;
}
