/** "My Weekend" — shared enums/constants for the status + private request system. */

export const WEEKEND_STATUS_TYPES = [
  'going_to_event',
  'have_plans',
  'nothing_planned',
  'bored',
  'feel_like_going_out',
  'looking_for_plans',
  'open_to_invitations',
  'looking_for_table',
  'looking_for_someone',
  'staying_in',
  'custom',
] as const;
export type WeekendStatusType = (typeof WEEKEND_STATUS_TYPES)[number];

export const WEEKEND_STATUS_LABELS: Record<WeekendStatusType, string> = {
  going_to_event: 'Going to an event',
  have_plans: 'I have plans',
  nothing_planned: 'Not doing anything this weekend',
  bored: 'Bored',
  feel_like_going_out: 'Feel like going out',
  looking_for_plans: 'Looking for plans',
  open_to_invitations: 'Open to invitations',
  looking_for_table: 'Looking for a table to join',
  looking_for_someone: 'Looking for someone to go with',
  staying_in: 'Staying in',
  custom: 'Custom status',
};

/** spec §8: "prioritize users who have actual stated plans". */
export const HAS_PLANS_STATUS_TYPES: WeekendStatusType[] = [
  'going_to_event',
  'have_plans',
  'looking_for_someone',
  'looking_for_table',
  'open_to_invitations',
];

/** spec §8: the separate "Looking for Plans" section further down the feed.
 *  'nothing_planned', 'staying_in' and 'custom' are active statuses (shown on
 *  the profile) but deliberately populate NEITHER feed rail — spec never
 *  lists them in either grouping, and mixing them in would blur "people who
 *  have plans" with "people still looking". */
export const LOOKING_FOR_PLANS_STATUS_TYPES: WeekendStatusType[] = ['bored', 'feel_like_going_out', 'looking_for_plans'];

export const WEEKEND_AUDIENCES = ['public', 'followers', 'selected', 'only_me'] as const;
export type WeekendAudience = (typeof WEEKEND_AUDIENCES)[number];

export const WEEKEND_MESSAGE_MAXLEN = 200;

export const WEEKEND_REQUEST_KINDS = [
  'invite_to_event',
  'buy_ticket',
  'buy_drink',
  'invite_to_table',
  'request_join_table',
  'request_to_meet',
  'make_plans_together',
] as const;
export type WeekendRequestKind = (typeof WEEKEND_REQUEST_KINDS)[number];

export const WEEKEND_REQUEST_KIND_LABELS: Record<WeekendRequestKind, string> = {
  invite_to_event: 'invited you to an event',
  buy_ticket: 'offered to buy you a ticket',
  buy_drink: 'offered to buy you a drink',
  invite_to_table: 'invited you to their table',
  request_join_table: 'asked to join your table',
  request_to_meet: 'requested to meet up',
  make_plans_together: 'wants to make plans together',
};

/** Kinds that require an eventId (spec §11/§12: both center on a specific event). */
export const WEEKEND_REQUEST_KINDS_REQUIRING_EVENT: WeekendRequestKind[] = ['invite_to_event', 'buy_ticket'];

export const WEEKEND_REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'completed'] as const;
export type WeekendRequestStatus = (typeof WEEKEND_REQUEST_STATUSES)[number];

export const WEEKEND_REQUEST_MESSAGE_MAXLEN = 300;
