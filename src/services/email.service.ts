/**
 * Email service for Carrot Tickets buyer auth + purchase receipts.
 *
 * Buyers who register/sign in with an email prove ownership via a 6-digit OTP,
 * mirroring the SMS OTP flow. Delivery is via the "Carrot Tickets" YeboLink
 * workspace (same key as SMS). Like SmsService.sendOtp, this is NOT
 * fire-and-forget: the caller surfaces a false result to the buyer (no silent
 * fallback — they cannot sign in without the code).
 *
 * sendTicketConfirmation mirrors SmsService.sendTicketConfirmation instead:
 * per global rule, purchase-confirmation emails are best-effort, fire-and-
 * forget — a failed receipt must NEVER roll back the ticket purchase. The
 * caller invokes this fire-and-forget and logs the boolean result. Email-only
 * buyers have no phone on file, so without this the SMS confirmation
 * silently skips them and they get no receipt at all.
 */
import { groupTicketCode } from '@utils/ticketCode.util';
import { TicketSummary } from './sms.service';
import { formatEventDateTime } from '@utils/eventTime.util';
import { YeboLinkClient } from './yebolink.client';

const FROM_NAME = 'Carrot Tickets';

export class EmailService {
  static async sendOtp(email: string, code: string): Promise<boolean> {
    if (!email || !code) return false;
    const subject = `${code} is your Carrot Tickets code`;
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1a1a1a">` +
      `<p>Your Carrot Tickets verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 10 minutes. Don't share it with anyone.</p>` +
      `</div>`;
    try {
      await YeboLinkClient.sendEmail(email, subject, html, FROM_NAME);
      console.log(`[Email] OTP dispatched to ${email} via YeboLink`);
      return true;
    } catch (error) {
      console.error('[Email] OTP send failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Send a ticket purchase confirmation receipt. Mirrors
   * SmsService.sendTicketConfirmation: best-effort, fire-and-forget, never
   * throws. Unlike the SMS version there's no segment-cost pressure, so every
   * ticket code is always listed in full.
   */
  static async sendTicketConfirmation(email: string, tickets: TicketSummary[]): Promise<boolean> {
    if (!email || tickets.length === 0) return false;

    const first = tickets[0];
    if (!first) return false;

    const dateFull = formatEventDateTime(first.startTime, first.eventDate, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const subject = `Your Carrot Tickets for ${first.eventName}`;
    const rows = tickets
      .map(
        (t) =>
          `<li style="margin-bottom:8px"><span style="font-family:monospace;font-weight:700">${groupTicketCode(t.ticketId)}</span></li>`,
      )
      .join('');

    // Optional: existing callers omit pdfUrl and this email body is byte-identical
    // to before — mirrors the SMS append in SmsService.sendTicketConfirmation.
    const pdfLink = first.pdfUrl
      ? `<p><a href="${first.pdfUrl}">Download your ticket</a></p>`
      : '';

    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1a1a1a">` +
      `<p>🎫 Your ${tickets.length > 1 ? `${tickets.length} tickets are` : 'ticket is'} confirmed!</p>` +
      `<p style="font-size:20px;font-weight:700;margin-bottom:4px">${first.eventName}</p>` +
      `<p style="margin-top:0;color:#555">${dateFull} • ${first.venue}</p>` +
      `<ul style="padding-left:20px">${rows}</ul>` +
      pdfLink +
      `<p>Show a code above at entry.</p>` +
      `</div>`;

    try {
      await YeboLinkClient.sendEmail(email, subject, html, FROM_NAME);
      console.log(`[Email] Ticket confirmation dispatched to ${email} via YeboLink`);
      return true;
    } catch (error) {
      console.error('[Email] Ticket confirmation send failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
