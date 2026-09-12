/**
 * SMS service for Carrot Tickets.
 *
 * Routing is split by destination network:
 *  - Eswatini (+268) numbers go through the unified Keshless SMS gateway at
 *    POST {KESHLESS_API_URL}/integration/sms — MTN SMPP via the USSD relay,
 *    cheap and reliable, but it has NO international interconnect.
 *  - Everything else (e.g. +27 buyers) goes through YeboLink
 *    (api.yebolink.com → Twilio), which has global SMS termination. Keshless
 *    silently accepted international sends but never delivered them, locking
 *    foreign buyers out of OTP login.
 *
 * Per global rule: purchase-confirmation SMS failures do NOT roll back the
 * ticket purchase. The caller invokes this fire-and-forget and logs the
 * boolean result. OTP sends surface failure to the buyer via the caller.
 */

import { groupTicketCode } from '@utils/ticketCode.util';
import { normalizePhone } from '@utils/phone.util';
import { shouldSendSms } from '@utils/smsPolicy.util';
import { formatEventDateTime } from '@utils/eventTime.util';
import { YeboLinkClient } from './yebolink.client';

const KESHLESS_API_URL = process.env['KESHLESS_API_URL'] || 'http://localhost:3000/api';
const KESHLESS_API_KEY = process.env['KESHLESS_API_KEY'] || '';

// Alphanumeric SMS sender ID shown on the recipient's handset. Capped at 11
// chars by GSM, so the brand is abbreviated ('Carrot Tickets' → 'CarrotTix').
// The Keshless gateway uses this per-message and leaves every other product's
// SMS on the shared 'Keshless' default. Overridable via env if it changes.
const SMS_SENDER_ID = process.env['SMS_SENDER_ID'] || 'CarrotTix';

export interface TicketSummary {
  ticketId: string;       // TKT-...
  eventName: string;
  eventDate: string;      // ISO (date-only marker, midnight UTC)
  startTime?: string;     // ISO instant — the real start; preferred for display
  venue: string;
  /** Direct link to this ticket's PDF. Optional: existing callers omit it and
   *  their message bodies are byte-identical to before. */
  pdfUrl?: string;
}

export class SmsService {
  /**
   * Low-level send. Picks the gateway by destination: Eswatini numbers via
   * Keshless (MTN SMPP), international via YeboLink (Twilio). Returns true if
   * the chosen gateway accepted the message, false otherwise. Always logs the
   * outcome.
   */
  private static async send(phoneNumber: string, message: string): Promise<boolean> {
    // Delivery policy gate. `send` is the single choke point — sendInternational
    // is only ever reached from here — so gating once covers both legs.
    const policy = shouldSendSms(phoneNumber);
    if (!policy.send) {
      console.log(`[SMS] Skipped send to ${phoneNumber}: ${policy.reason}`);
      return false;
    }

    const normalized = normalizePhone(phoneNumber);

    if (!normalized.startsWith('+268')) {
      return this.sendInternational(normalized, message);
    }

    if (!KESHLESS_API_KEY) {
      console.error('[SMS] KESHLESS_API_KEY missing — cannot reach unified gateway');
      return false;
    }

    try {
      const response = await fetch(`${KESHLESS_API_URL}/integration/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': KESHLESS_API_KEY,
        },
        body: JSON.stringify({ to: phoneNumber, message, senderId: SMS_SENDER_ID }),
      });

      if (response.ok) {
        console.log(`[SMS] Dispatched to ${phoneNumber} via Keshless gateway`);
        return true;
      }

      const errorText = await response.text().catch(() => '');
      console.error(`[SMS] Gateway returned ${response.status}: ${errorText.slice(0, 200)}`);
      return false;
    } catch (error) {
      console.error('[SMS] Error reaching gateway', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * International leg — YeboLink (Twilio). The Keshless gateway's MTN SMPP
   * link cannot terminate outside Eswatini, so any non-+268 number lands here.
   */
  private static async sendInternational(phoneNumber: string, message: string): Promise<boolean> {
    try {
      const result = await YeboLinkClient.sendSMS(phoneNumber, message, SMS_SENDER_ID);
      console.log(`[SMS] Dispatched to ${phoneNumber} via YeboLink (international), status=${result.status}`);
      return true;
    } catch (error) {
      console.error('[SMS] YeboLink international send failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Send a ticket purchase confirmation. For multi-ticket buys, lists each
   * ticketId on its own line up to a soft cap, falling back to a count if
   * the body would exceed ~320 chars (≈ 2 SMS segments) to keep costs sane.
   */
  static async sendTicketConfirmation(
    phoneNumber: string,
    tickets: TicketSummary[],
  ): Promise<boolean> {
    if (!phoneNumber || tickets.length === 0) return false;

    const first = tickets[0];
    if (!first) return false;

    const dateShort = formatEventDateTime(first.startTime, first.eventDate, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

    const profileNote = 'View anytime in your Carrot profile.';

    let body: string;
    if (tickets.length === 1) {
      body =
        `🎫 ${first.eventName} ticket confirmed!\n` +
        `Code: ${groupTicketCode(first.ticketId)}\n` +
        `${dateShort} • ${first.venue}\n` +
        `Show this code at entry.` +
        (first.pdfUrl ? `\nTicket: ${first.pdfUrl}` : '') +
        ` ${profileNote}`;
    } else {
      const codes = tickets.map((t) => groupTicketCode(t.ticketId)).join('\n');
      const candidate =
        `🎫 ${tickets.length} ${first.eventName} tickets confirmed!\n` +
        `${codes}\n` +
        `${dateShort} • ${first.venue}\n` +
        profileNote;
      body = candidate.length <= 320
        ? candidate
        : `🎫 ${tickets.length} ${first.eventName} tickets confirmed! See your receipt for codes. ${dateShort} • ${first.venue} ${profileNote}`;
    }

    return this.send(phoneNumber, body);
  }

  /**
   * Notify the support line that a new contact-form message arrived. This is a
   * best-effort ALERT only — the message itself is stored durably in the
   * ContactMessage collection, so a failed/undeliverable SMS never loses data
   * (hence fire-and-forget, per the telemetry exception to the no-silent-
   * fallback rule). Sends only when SUPPORT_ALERT_PHONE is configured.
   */
  static async sendContactAlert(name: string, subject: string): Promise<boolean> {
    const to = process.env['SUPPORT_ALERT_PHONE'];
    if (!to) {
      console.warn('[SMS] SUPPORT_ALERT_PHONE not set — skipping contact-form alert');
      return false;
    }
    const body =
      `📨 New Carrot Tickets support message from ${name}.\n` +
      `Subject: ${subject}\n` +
      `Check the support inbox to reply.`;
    return this.send(to, body);
  }

  /**
   * Send a login one-time passcode. Unlike the purchase confirmation, the
   * OTP send is NOT fire-and-forget — the caller must surface a failure to
   * the buyer (they can't log in without the code), per the no-silent-
   * fallback rule. Returns true only if the gateway accepted the message.
   */
  static async sendOtp(phoneNumber: string, code: string): Promise<boolean> {
    if (!phoneNumber || !code) return false;
    const body =
      `${code} is your Carrot Tickets login code.\n` +
      `It expires in 10 minutes. Don't share it with anyone.`;
    return this.send(phoneNumber, body);
  }
}
