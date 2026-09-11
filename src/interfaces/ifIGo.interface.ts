/**
 * "If I Go…" — an interactive Story type (spec: If I Go…). A creator picks an
 * upcoming event and asks followers "If I go to [Event], will you...?" with a
 * set of response options; each respondent can select one or more options and
 * the creator tracks their private status per option while the public side
 * only ever sees aggregate counts (spec §6/§7 — never per-respondent identity
 * or confirmation status).
 */

/** Preset response options every creator can pick from (spec §2). Custom
 *  options are free-text, slugified into a `custom:<slug>` key at creation
 *  time — see ifIGo.service#normalizeOptions. */
export const SUGGESTED_IF_I_GO_OPTIONS: { key: string; label: string }[] = [
  { key: 'buy_ticket', label: 'Buy me a ticket' },
  { key: 'buy_drink', label: 'Buy me a drink' },
  { key: 'join_table', label: 'Join my table' },
  { key: 'ask_join_table', label: 'Ask me to join your table' },
  { key: 'go_with_me', label: 'Go with me' },
  { key: 'share_transport', label: 'Share transport with me' },
  { key: 'meet_there', label: 'Meet me there' },
  { key: 'already_going', label: "I'm already going" },
];

export const SUGGESTED_IF_I_GO_OPTION_KEYS = new Set(SUGGESTED_IF_I_GO_OPTIONS.map((o) => o.key));

/** Limits (spec §2 "reasonable character and option limits"). */
export const IF_I_GO_MIN_OPTIONS = 2;
export const IF_I_GO_MAX_OPTIONS = 8;
export const IF_I_GO_OPTION_LABEL_MAXLEN = 40;
export const IF_I_GO_PRIVATE_MESSAGE_MAXLEN = 300;

/**
 * Private lifecycle of ONE respondent's selection of ONE option (spec §7).
 * Only the creator and the respondent ever see this — public results are
 * always just an aggregate count, never a status.
 *
 * 'interested'  — default for options with no further workflow (go_with_me,
 *                 share_transport, meet_there, already_going, custom).
 * 'offered'     — the respondent has made an offer (buy_ticket, buy_drink);
 *                 no creator accept/decline needed for buy_ticket (payment
 *                 IS the confirmation); buy_drink offers can be
 *                 accepted/declined by the creator.
 * 'request_sent'— respondent asked for something the creator must act on
 *                 (join_table, ask_join_table).
 * 'accepted'    — creator accepted an offer/request.
 * 'declined'    — creator declined an offer/request.
 * 'completed'   — the underlying Carrot action genuinely succeeded (ticket
 *                 purchase verified, drink purchase verified, etc.) — the
 *                 ONLY status this codebase ever sets after checking real
 *                 state, never optimistically (see ifIGo.service#confirmTicketPurchase).
 */
export type IfIGoResponseStatus = 'interested' | 'offered' | 'request_sent' | 'accepted' | 'declined' | 'completed';

/** Who besides the creator's followers may view/respond to this Story (spec §1.4). */
export type IfIGoAudience = 'everyone' | 'followers';

export interface IfIGoOptionDef {
  key: string;
  label: string;
  order: number;
}
