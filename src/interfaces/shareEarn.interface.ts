/**
 * Share&Earn — direct-referral promoter programme. A promoter shares a
 * unique link for one event's campaign and earns non-monetary rewards
 * (points, tickets, upgrades, vouchers, merch, benefits) for confirmed
 * ticket sales personally referred through it. No cash, no commissions,
 * no multi-level referrals — see docs/spec in the task ledger.
 */

export type ShareEarnCampaignStatus = 'draft' | 'active' | 'paused' | 'closed';

export type ShareEarnRewardType =
  | 'points'
  | 'ticket_discount'
  | 'free_ticket'
  | 'upgrade'
  | 'voucher'
  | 'merchandise'
  | 'benefit';

export type ShareEarnRewardProvider = 'carrot' | 'organizer';

/** A per-sale reward ("N points per confirmed sale") or a milestone reward
 *  ("reward after 5 confirmed sales") or the top-promoter reward. */
export type ShareEarnRewardTriggerKind = 'per_sale' | 'milestone' | 'top_promoter';

export interface IShareEarnRewardRule {
  /** Stable id for this rule within the campaign, referenced by issued rewards. */
  ruleId: string;
  trigger: ShareEarnRewardTriggerKind;
  /** Confirmed-sale count that triggers this rule. Required for 'milestone', ignored otherwise. */
  milestoneSalesCount?: number;
  rewardType: ShareEarnRewardType;
  provider: ShareEarnRewardProvider;
  /** Points amount, for rewardType='points'. */
  pointsAmount?: number;
  /** Human description of a non-points reward ("Free VIP upgrade", "E50 bar voucher"). */
  description?: string;
  /** Monetary value organizer/Carrot assigns for budget accounting (never shown to buyer as cash). */
  costValue?: number;
}

export type ShareEarnPromoterStatus = 'pending_approval' | 'active' | 'paused' | 'disqualified';

export type ShareEarnReferralStatus = 'pending' | 'confirmed' | 'reversed' | 'disqualified';

export type ShareEarnRewardStatus = 'pending' | 'confirmed' | 'available' | 'redeemed' | 'reversed';

export type ShareEarnAuditAction =
  | 'campaign_created'
  | 'campaign_updated'
  | 'campaign_activated'
  | 'campaign_paused'
  | 'campaign_registrations_paused'
  | 'campaign_registrations_resumed'
  | 'campaign_closed'
  | 'promoter_joined'
  | 'promoter_approved'
  | 'referral_attributed'
  | 'referral_confirmed'
  | 'referral_reversed'
  | 'referral_flagged'
  | 'referral_disqualified'
  | 'reward_created'
  | 'reward_confirmed'
  | 'reward_redeemed'
  | 'reward_reversed';
