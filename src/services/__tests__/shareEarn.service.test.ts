import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { ShareEarnCampaign } from '@models/shareEarnCampaign.model';
import { ShareEarnPromoter } from '@models/shareEarnPromoter.model';
import { ShareEarnReferral } from '@models/shareEarnReferral.model';
import { ShareEarnReward } from '@models/shareEarnReward.model';
import { ShareEarnPointsAward } from '@models/shareEarnPointsAward.model';
import { ShareEarnAuditLog } from '@models/shareEarnAuditLog.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus, ITicketSale } from '@interfaces/ticket.interface';
import { ShareEarnService, totalShareEarnPoints } from '@services/shareEarn.service';

jest.mock('@services/push.service', () => ({ PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) } }));

async function seedBuyer(overrides: Partial<{ name: string }> = {}) {
  return Buyer.create({
    phone: `+2687842${Math.floor(1000 + Math.random() * 8999)}`,
    password: 'testpass123',
    name: overrides.name ?? 'Test Buyer',
    dmPrivacy: 'community',
    notificationPrefs: { announcements: true, dms: true, mentions: true, social: true, reminders: true },
  });
}

async function seedSale(opts: {
  eventId: string;
  vendorId: string;
  buyerId?: mongoose.Types.ObjectId;
  totalAmount?: number;
  quantity?: number;
  ticketTypeId?: string;
  referralCode?: string;
}): Promise<ITicketSale> {
  return TicketSale.create({
    eventId: opts.eventId,
    vendorId: opts.vendorId,
    buyerId: opts.buyerId,
    quantity: opts.quantity ?? 1,
    totalAmount: opts.totalAmount ?? 100,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(opts.vendorId),
    soldByType: 'Vendor',
    ...(opts.ticketTypeId
      ? { lines: [{ ticketTypeId: opts.ticketTypeId, ticketTypeName: 'General', unitPrice: opts.totalAmount ?? 100, quantity: opts.quantity ?? 1 }] }
      : {}),
    ...(opts.referralCode ? { shareEarnReferralCode: opts.referralCode } : {}),
  }) as unknown as Promise<ITicketSale>;
}

describe('ShareEarnService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await ShareEarnCampaign.init();
    await ShareEarnPromoter.init();
    await ShareEarnReferral.init();
    await ShareEarnReward.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedActiveCampaign(opts: {
    vendorId: mongoose.Types.ObjectId;
    eventId: string;
    rewardRules?: any[];
    maxPromoters?: number;
    maxRewardBudget?: number;
    allowSelfReferral?: boolean;
    requirePromoterApproval?: boolean;
    endsInDays?: number;
  }) {
    const vendor = { _id: opts.vendorId };
    const campaign = await ShareEarnService.upsertCampaign(opts.eventId, vendor, {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + (opts.endsInDays ?? 7) * 24 * 60 * 60 * 1000),
      eligibleTicketTypeIds: [],
      rewardRules: opts.rewardRules ?? [
        { trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 },
      ],
      maxPromoters: opts.maxPromoters,
      maxRewardBudget: opts.maxRewardBudget,
      allowSelfReferral: opts.allowSelfReferral ?? false,
      requirePromoterApproval: opts.requirePromoterApproval ?? false,
    });
    return ShareEarnService.activateCampaign(opts.eventId, String(opts.vendorId));
  }

  describe('upsertCampaign', () => {
    it('rejects a closing date on or before the starting date', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await expect(
        ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
          startsAt: new Date(), endsAt: new Date(Date.now() - 1000), rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 5 }],
        })
      ).rejects.toThrow(/closing date/i);
    });

    it('rejects activation with no reward rules configured', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await expect(
        ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
          startsAt: new Date(), endsAt: new Date(Date.now() + 86400000), rewardRules: [],
        })
      ).rejects.toThrow(/at least one reward/i);
    });

    it('a rival vendor cannot configure another organizer\'s campaign', async () => {
      const { eventId } = await seedPublishedEvent();
      await expect(
        ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId() }, {
          startsAt: new Date(), endsAt: new Date(Date.now() + 86400000), rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 5 }],
        })
      ).rejects.toThrow(/not your event/i);
    });

    it('once active, refuses to remove or shrink a rule promoters may have already qualified under', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const vendor = { _id: new mongoose.Types.ObjectId(vendorId) };
      const draft = await ShareEarnService.upsertCampaign(eventId, vendor, {
        startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 }],
      });
      await ShareEarnService.activateCampaign(eventId, vendorId);
      const ruleId = draft.rewardRules[0]!.ruleId;

      // Removing the rule entirely is refused.
      await expect(
        ShareEarnService.upsertCampaign(eventId, vendor, { startsAt: draft.startsAt, endsAt: draft.endsAt, rewardRules: [] })
      ).rejects.toThrow(/at least one reward/i);

      // Shrinking the points amount on the existing rule is refused.
      await expect(
        ShareEarnService.upsertCampaign(eventId, vendor, {
          startsAt: draft.startsAt, endsAt: draft.endsAt,
          rewardRules: [{ ruleId, trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 5 }],
        })
      ).rejects.toThrow(/cannot reduce/i);

      // Raising it, or adding a new rule alongside it, is allowed.
      const updated = await ShareEarnService.upsertCampaign(eventId, vendor, {
        startsAt: draft.startsAt, endsAt: draft.endsAt,
        rewardRules: [
          { ruleId, trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 15 },
          { trigger: 'milestone', milestoneSalesCount: 3, rewardType: 'free_ticket', provider: 'organizer', description: 'Free ticket' },
        ],
      });
      expect(updated.rewardRules).toHaveLength(2);
    });

    it('cannot move the closing date earlier once active', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const campaign = await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, endsInDays: 7 });
      const plainRules = JSON.parse(JSON.stringify(campaign.rewardRules));
      await expect(
        ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
          startsAt: campaign.startsAt, endsAt: new Date(Date.now() + 1000),
          rewardRules: plainRules,
        })
      ).rejects.toThrow(/cannot move the closing date earlier/i);
    });
  });

  describe('joinCampaign', () => {
    it('registers a promoter with a unique referral code and prevents duplicate joins', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const buyer = await seedBuyer();

      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });
      expect(promoter.referralCode).toBeTruthy();
      expect(promoter.status).toBe('active');

      const { promoter: again } = await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });
      expect(String(again._id)).toBe(String(promoter._id));
      expect(await ShareEarnPromoter.countDocuments({ campaignId: promoter.campaignId, buyerId: buyer._id })).toBe(1);
    });

    it('registers as pending_approval when the organizer requires promoter approval', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, requirePromoterApproval: true });
      const buyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });
      expect(promoter.status).toBe('pending_approval');
    });

    it('refuses new promoters once the max-promoters cap is reached', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, maxPromoters: 1 });
      const buyer1 = await seedBuyer();
      const buyer2 = await seedBuyer();
      await ShareEarnService.joinCampaign(eventId, { _id: buyer1._id as mongoose.Types.ObjectId });
      await expect(
        ShareEarnService.joinCampaign(eventId, { _id: buyer2._id as mongoose.Types.ObjectId })
      ).rejects.toThrow(/maximum number of promoters/i);
    });

    it('refuses to join a draft (not-yet-active) campaign', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
        startsAt: new Date(), endsAt: new Date(Date.now() + 86400000),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 5 }],
      });
      const buyer = await seedBuyer();
      await expect(ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId })).rejects.toThrow(/not open/i);
    });
  });

  describe('referral tracking + confirmation', () => {
    it('trackClick increments clicks/unique visitors once per visitor key', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });

      await ShareEarnService.trackClick(promoter.referralCode, 'visitor-a', {});
      await ShareEarnService.trackClick(promoter.referralCode, 'visitor-a', {});
      await ShareEarnService.trackClick(promoter.referralCode, 'visitor-b', {});

      const refreshed = await ShareEarnPromoter.findById(promoter._id);
      expect(refreshed!.clicks).toBe(3);
      expect(refreshed!.uniqueVisitors).toBe(2);
    });

    it('a confirmed sale issues a per-sale points reward and credits the buyer\'s points ledger', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });

      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode, totalAmount: 150 });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);

      const referral = await ShareEarnReferral.findOne({ ticketSaleId: sale._id });
      expect(referral!.status).toBe('confirmed');
      expect(referral!.eligibleSalesValue).toBe(150);

      const refreshedPromoter = await ShareEarnPromoter.findById(promoter._id);
      expect(refreshedPromoter!.confirmedSalesCount).toBe(1);
      expect(refreshedPromoter!.eligibleSalesValue).toBe(150);
      expect(refreshedPromoter!.confirmedRewardsCount).toBe(1);

      const reward = await ShareEarnReward.findOne({ promoterId: promoter._id });
      expect(reward!.status).toBe('available');
      expect(reward!.pointsAmount).toBe(10);

      expect(await totalShareEarnPoints(promoterBuyer._id as mongoose.Types.ObjectId)).toBe(10);
    });

    it('does not attribute or credit a self-referred purchase unless the campaign explicitly allows it', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, allowSelfReferral: false });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });

      const sale = await seedSale({ eventId, vendorId, buyerId: promoterBuyer._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      expect(await ShareEarnReferral.countDocuments({ ticketSaleId: sale._id })).toBe(0);
    });

    it('a confirmed sale outside the eligible ticket types earns no referral', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
        startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000),
        eligibleTicketTypeIds: ['vip-tier-only'],
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 }],
      });
      await ShareEarnService.activateCampaign(eventId, vendorId);
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });

      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode, ticketTypeId: 'general-tier' });
      await ShareEarnService.registerPendingReferral(sale);
      expect(await ShareEarnReferral.countDocuments({ ticketSaleId: sale._id })).toBe(0);
    });

    it('fires a milestone reward exactly once, at the confirmation that reaches the threshold', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({
        vendorId: new mongoose.Types.ObjectId(vendorId), eventId,
        rewardRules: [{ trigger: 'milestone', milestoneSalesCount: 2, rewardType: 'free_ticket', provider: 'organizer', description: 'Free ticket', costValue: 100 }],
      });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });

      for (let i = 0; i < 2; i++) {
        const purchaser = await seedBuyer({ name: `Purchaser ${i}` });
        const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
        await ShareEarnService.registerPendingReferral(sale);
        await ShareEarnService.confirmReferralForSale(sale);
      }

      const rewards = await ShareEarnReward.find({ promoterId: promoter._id, trigger: 'milestone' });
      expect(rewards).toHaveLength(1);
      // Non-points, organizer-provided reward needs fulfilment confirmation before it's available.
      expect(rewards[0]!.status).toBe('confirmed');
    });

    it('flags a referral instead of auto-confirming it when the same buyer repeatedly purchases under one promoter', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Repeat purchaser' });

      const sale1 = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale1);
      await ShareEarnService.confirmReferralForSale(sale1);

      const sale2 = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale2);
      await ShareEarnService.confirmReferralForSale(sale2);

      const referral2 = await ShareEarnReferral.findOne({ ticketSaleId: sale2._id });
      expect(referral2!.status).toBe('pending');
      expect(referral2!.flagged).toBe(true);
    });

    it('never awards the same ticket sale to more than one promoter', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const buyer1 = await seedBuyer();
      const buyer2 = await seedBuyer();
      const { promoter: p1 } = await ShareEarnService.joinCampaign(eventId, { _id: buyer1._id as mongoose.Types.ObjectId });
      await ShareEarnService.joinCampaign(eventId, { _id: buyer2._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });

      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: p1.referralCode });
      // ticketSaleId is unique on the referral model — enforced at the data layer.
      await expect(
        ShareEarnReferral.create({ campaignId: p1.campaignId, eventId: p1.eventId, promoterId: p1._id, ticketSaleId: sale._id, status: 'pending' })
      ).resolves.toBeDefined();
      await expect(
        ShareEarnReferral.create({ campaignId: p1.campaignId, eventId: p1.eventId, promoterId: p1._id, ticketSaleId: sale._id, status: 'pending' })
      ).rejects.toThrow();
    });
  });

  describe('reversal on refund / organizer disqualification', () => {
    it('reversing a refunded sale withdraws its promoter\'s confirmed sale, tickets, value and available reward', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });

      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode, totalAmount: 100 });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);
      expect(await totalShareEarnPoints(promoterBuyer._id as mongoose.Types.ObjectId)).toBe(10);

      await ShareEarnService.reverseReferralForRefund(sale, {} as any);

      const referral = await ShareEarnReferral.findOne({ ticketSaleId: sale._id });
      expect(referral!.status).toBe('reversed');
      const reward = await ShareEarnReward.findOne({ promoterId: promoter._id });
      expect(reward!.status).toBe('reversed');

      const refreshedPromoter = await ShareEarnPromoter.findById(promoter._id);
      expect(refreshedPromoter!.confirmedSalesCount).toBe(0);
      expect(refreshedPromoter!.eligibleSalesValue).toBe(0);
      expect(refreshedPromoter!.confirmedRewardsCount).toBe(0);

      // Points ledger carries an honest offsetting entry, never a silent negative balance edit.
      expect(await totalShareEarnPoints(promoterBuyer._id as mongoose.Types.ObjectId)).toBe(0);
    });

    it('organizer disqualification requires a reason and writes an auditable trail', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });
      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);
      const referral = (await ShareEarnReferral.findOne({ ticketSaleId: sale._id }))!;

      await expect(
        ShareEarnService.reviewReferral(eventId, vendorId, String(referral._id), 'disqualify', undefined, new mongoose.Types.ObjectId(vendorId))
      ).rejects.toThrow(/reason is required/i);

      await ShareEarnService.reviewReferral(eventId, vendorId, String(referral._id), 'disqualify', 'Suspicious self-dealing', new mongoose.Types.ObjectId(vendorId));
      const disqualified = await ShareEarnReferral.findById(referral._id);
      expect(disqualified!.status).toBe('disqualified');
      expect(disqualified!.disqualifiedReason).toBe('Suspicious self-dealing');

      const logs = await ShareEarnAuditLog.find({ campaignId: promoter.campaignId, action: 'referral_disqualified' });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.reason).toBe('Suspicious self-dealing');
    });
  });

  describe('reward redemption', () => {
    it('redeems an available non-points reward exactly once', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({
        vendorId: new mongoose.Types.ObjectId(vendorId), eventId,
        rewardRules: [{ trigger: 'per_sale', rewardType: 'voucher', provider: 'carrot', description: 'E20 voucher', costValue: 20 }],
      });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });
      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);
      const reward = (await ShareEarnReward.findOne({ promoterId: promoter._id }))!;

      const redeemed = await ShareEarnService.redeemReward({ _id: promoterBuyer._id as mongoose.Types.ObjectId }, String(reward._id));
      expect(redeemed.status).toBe('redeemed');
      await expect(ShareEarnService.redeemReward({ _id: promoterBuyer._id as mongoose.Types.ObjectId }, String(reward._id))).rejects.toThrow(/already redeemed/i);
    });

    it('a points reward cannot be redeemed through the reward-redemption endpoint', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });
      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);
      const reward = (await ShareEarnReward.findOne({ promoterId: promoter._id }))!;
      await expect(ShareEarnService.redeemReward({ _id: promoterBuyer._id as mongoose.Types.ObjectId }, String(reward._id))).rejects.toThrow(/used automatically/i);
    });

    it('organizer confirmation of a pending-fulfilment reward makes it available and notifies the promoter', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({
        vendorId: new mongoose.Types.ObjectId(vendorId), eventId,
        rewardRules: [{ trigger: 'per_sale', rewardType: 'merchandise', provider: 'organizer', description: 'T-shirt' }],
      });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });
      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);
      const reward = (await ShareEarnReward.findOne({ promoterId: promoter._id }))!;
      expect(reward.status).toBe('confirmed');

      const confirmed = await ShareEarnService.confirmRewardFulfilment(eventId, vendorId, String(reward._id));
      expect(confirmed.status).toBe('available');
    });
  });

  describe('leaderboard', () => {
    it('excludes promoters who opted out, but keeps their earned rewards', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const promoterBuyer = await seedBuyer();
      const { promoter } = await ShareEarnService.joinCampaign(eventId, { _id: promoterBuyer._id as mongoose.Types.ObjectId });
      const purchaser = await seedBuyer({ name: 'Purchaser' });
      const sale = await seedSale({ eventId, vendorId, buyerId: purchaser._id as mongoose.Types.ObjectId, referralCode: promoter.referralCode });
      await ShareEarnService.registerPendingReferral(sale);
      await ShareEarnService.confirmReferralForSale(sale);

      await ShareEarnService.setLeaderboardOptOut({ _id: promoterBuyer._id as mongoose.Types.ObjectId }, String(promoter._id), true);
      const leaderboard = await ShareEarnService.getLeaderboard(eventId);
      expect(leaderboard).toEqual([]);

      const refreshed = await ShareEarnPromoter.findById(promoter._id);
      expect(refreshed!.confirmedRewardsCount).toBe(1); // reward untouched by opting out
    });
  });

  describe('campaign lifecycle notifications', () => {
    it('notifies each promoter exactly once when a campaign is about to close', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const campaign = await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, endsInDays: 7 });
      await ShareEarnCampaign.updateOne({ _id: campaign._id }, { $set: { endsAt: new Date(Date.now() + 60 * 60 * 1000) } }); // closes in 1h
      const buyer = await seedBuyer();
      await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });

      const first = await ShareEarnService.notifyCampaignsClosingSoon();
      expect(first).toBe(1);
      const second = await ShareEarnService.notifyCampaignsClosingSoon();
      expect(second).toBe(0); // deduped — already notified this promoter for this campaign

      const { Notification } = await import('@models/notification.model');
      const count = await Notification.countDocuments({ recipientId: buyer._id, type: 'share_earn_campaign_closing_soon' });
      expect(count).toBe(1);
    });

    it('does not notify about a campaign that is not yet close to its closing date', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId, endsInDays: 7 });
      const buyer = await seedBuyer();
      await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });
      expect(await ShareEarnService.notifyCampaignsClosingSoon()).toBe(0);
    });

    it('notifies promoters when the organizer changes an important term of an active campaign', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const campaign = await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const buyer = await seedBuyer();
      await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });

      await ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        rewardRules: JSON.parse(JSON.stringify(campaign.rewardRules)),
        terms: 'Updated terms: rewards paid out within 14 days.',
      });

      const { Notification } = await import('@models/notification.model');
      const count = await Notification.countDocuments({ recipientId: buyer._id, type: 'share_earn_campaign_terms_changed' });
      expect(count).toBe(1);
    });

    it('does not notify when saving a campaign with no meaningful term change', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const campaign = await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(vendorId), eventId });
      const buyer = await seedBuyer();
      await ShareEarnService.joinCampaign(eventId, { _id: buyer._id as mongoose.Types.ObjectId });

      await ShareEarnService.upsertCampaign(eventId, { _id: new mongoose.Types.ObjectId(vendorId) }, {
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        rewardRules: JSON.parse(JSON.stringify(campaign.rewardRules)),
      });

      const { Notification } = await import('@models/notification.model');
      const count = await Notification.countDocuments({ recipientId: buyer._id, type: 'share_earn_campaign_terms_changed' });
      expect(count).toBe(0);
    });
  });

  describe('autoCloseExpiredCampaigns', () => {
    it('closes active/paused campaigns past their end date and leaves future ones alone', async () => {
      const past = await seedPublishedEvent();
      const future = await seedPublishedEvent();
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(past.vendorId), eventId: past.eventId, endsInDays: 7 });
      await ShareEarnCampaign.updateOne({ eventId: past.eventId }, { $set: { endsAt: new Date(Date.now() - 1000) } });
      await seedActiveCampaign({ vendorId: new mongoose.Types.ObjectId(future.vendorId), eventId: future.eventId, endsInDays: 7 });

      const closedCount = await ShareEarnService.autoCloseExpiredCampaigns();
      expect(closedCount).toBe(1);
      expect((await ShareEarnCampaign.findOne({ eventId: past.eventId }))!.status).toBe('closed');
      expect((await ShareEarnCampaign.findOne({ eventId: future.eventId }))!.status).toBe('active');
    });
  });
});
