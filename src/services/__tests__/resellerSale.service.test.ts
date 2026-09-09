import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';

// Mock MtnMomoClient BEFORE importing ResellerSaleService (which pulls in
// TicketService → MtnMomoClient). Same module-level pattern as momoSale.test.ts.
const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

const mockSendTicketConfirmation = jest.fn();
jest.mock('@services/sms.service', () => ({
  SmsService: {
    sendTicketConfirmation: (...args: any[]) => mockSendTicketConfirmation(...args),
    sendOtp: jest.fn(),
  },
}));

import { ResellerSaleService } from '@services/resellerSale.service';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures'; // create: returns {eventId, ticketTypeId, capacity}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => {
  // Default resolved value so the fire-and-forget .catch() inside finalizeMomoSale
  // doesn't crash when it calls SmsService.sendTicketConfirmation without a test setup.
  mockSendTicketConfirmation.mockResolvedValue(true);
});
afterEach(() => {
  mockMomoInstance.isConfigured.mockReset();
  mockMomoInstance.requestToPay.mockReset();
  mockMomoInstance.getStatus.mockReset();
  mockSendTicketConfirmation.mockReset();
});

it('cash sale: completed, snapshot reseller-held', async () => {
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, cashEnabled: true });
  const r = await Reseller.create({ businessName: 'PnP', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  const res = await ResellerSaleService.createSale({
    operatorId: '64b000000000000000000001', resellerId: r._id.toString(), hubId: '64b000000000000000000002',
    eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], paymentMethod: 'cash', customerPhone: '+26878422613',
  });
  expect(res.status).toBe('completed');

  const { TicketSale } = await import('@models/ticketSale.model');
  const sale = await TicketSale.findById(res.saleId);
  expect(sale!.fundsCustody).toBe('reseller');
  expect(sale!.organizerProceeds).toBe(92);
  expect(sale!.soldByType).toBe('ResellerOperator');
});

it('rejects a disabled payment method', async () => {
  await PaymentConfigService.update({ keshlessWalletEnabled: false });
  const r = await Reseller.create({ businessName: 'X', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 50, capacity: 2 });
  await expect(ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(), resellerId: r._id.toString(), hubId: new mongoose.Types.ObjectId().toString(), eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], paymentMethod: 'keshless_wallet',
  })).rejects.toThrow(/not available/i);
});

it('oversell beyond capacity is rejected', async () => {
  const r = await Reseller.create({ businessName: 'Y', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 10, capacity: 1 });
  const base = { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: r._id.toString(), hubId: new mongoose.Types.ObjectId().toString(), eventId, paymentMethod: 'cash' as const };
  const oneTicket = [{ ticketTypeId, quantity: 1 }];
  await ResellerSaleService.createSale({ ...base, items: oneTicket });
  await expect(ResellerSaleService.createSale({ ...base, items: oneTicket })).rejects.toThrow();
});

it('mtn_momo sale: returns pending + referenceId; PENDING sale is reseller-attributed with carrot custody', async () => {
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, mtnMomoEnabled: true });
  const r = await Reseller.create({ businessName: 'MoMoPnP', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  mockMomoInstance.isConfigured.mockReturnValue(true);
  mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_RES_SVC' });

  const res = await ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(),
    resellerId: r._id.toString(),
    hubId: new mongoose.Types.ObjectId().toString(),
    eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], paymentMethod: 'mtn_momo',
    customerPhone: '+26878422613',
  });

  expect(res.status).toBe('pending');
  if (res.status !== 'pending') throw new Error('expected pending');
  expect(res.referenceId).toBe('R_RES_SVC');
  expect(res.saleId).toBeTruthy();
  expect(res.expiresAt).toBeInstanceOf(Date);

  const { TicketSale } = await import('@models/ticketSale.model');
  const sale = await TicketSale.findById(res.saleId);
  expect(sale!.paymentStatus).toBe('pending');
  expect(sale!.soldByType).toBe('ResellerOperator');
  expect(sale!.resellerId!.toString()).toBe(r._id.toString());
  expect(sale!.fundsCustody).toBe('carrot');
  expect(sale!.organizerProceeds).toBe(92); // face − commission − fee
});

it('mtn_momo sale: throws when no buyer phone supplied (no silent fallback)', async () => {
  await PaymentConfigService.update({ mtnMomoEnabled: true });
  const r = await Reseller.create({ businessName: 'NoPhone', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  mockMomoInstance.isConfigured.mockReturnValue(true);

  await expect(ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(),
    resellerId: r._id.toString(),
    hubId: new mongoose.Types.ObjectId().toString(),
    eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], paymentMethod: 'mtn_momo',
  })).rejects.toThrow(/phone/i);
});

it('finalizeSale: a DIFFERENT reseller cannot finalize (ownership isolation)', async () => {
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, mtnMomoEnabled: true });
  const owner = await Reseller.create({ businessName: 'OwnerPnP', commissionPercent: null });
  const attacker = await Reseller.create({ businessName: 'AttackerPnP', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  mockMomoInstance.isConfigured.mockReturnValue(true);
  mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_OWNED' });

  const created = await ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(),
    resellerId: owner._id.toString(),
    hubId: new mongoose.Types.ObjectId().toString(),
    eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], paymentMethod: 'mtn_momo',
    customerPhone: '+26878422613',
  });
  if (created.status !== 'pending') throw new Error('expected pending');

  await expect(
    ResellerSaleService.finalizeSale(created.referenceId, attacker._id.toString())
  ).rejects.toThrow(/not authorized|forbidden|ownership/i);

  // getStatus must never be consulted — we reject before touching MTN
  expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();
});

it('finalizeSale: unknown referenceId throws not-found', async () => {
  await expect(
    ResellerSaleService.finalizeSale('does-not-exist', new mongoose.Types.ObjectId().toString())
  ).rejects.toThrow(/not found/i);
});

it('sendSaleSms: sends a confirmation for an owned cash sale', async () => {
  mockSendTicketConfirmation.mockResolvedValue(true);
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, cashEnabled: true });
  const r = await Reseller.create({ businessName: 'SMSCo', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  const sale = await ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(), resellerId: r._id.toString(),
    hubId: new mongoose.Types.ObjectId().toString(), eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
    paymentMethod: 'cash', customerName: 'Test Buyer', customerPhone: '+26878422613',
  });

  const res = await ResellerSaleService.sendSaleSms(sale.saleId, r._id.toString());

  expect(res.sent).toBe(true);
  expect(mockSendTicketConfirmation).toHaveBeenCalledTimes(1);
  const [phone, summaries] = mockSendTicketConfirmation.mock.calls[0];
  expect(phone).toBe('+26878422613');
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toHaveProperty('ticketId');
  expect(summaries[0]).toHaveProperty('eventName');
});

it('sendSaleSms: rejects a sale owned by another reseller and does not send', async () => {
  mockSendTicketConfirmation.mockResolvedValue(true);
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, cashEnabled: true });
  const owner = await Reseller.create({ businessName: 'Owner', commissionPercent: null });
  const other = await Reseller.create({ businessName: 'Other', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 50, capacity: 3 });

  const sale = await ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(), resellerId: owner._id.toString(),
    hubId: new mongoose.Types.ObjectId().toString(), eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
    paymentMethod: 'cash', customerPhone: '+26878422613',
  });

  await expect(
    ResellerSaleService.sendSaleSms(sale.saleId, other._id.toString())
  ).rejects.toThrow(/not authorized/i);
  expect(mockSendTicketConfirmation).not.toHaveBeenCalled();
});

it('sendSaleSms: throws not found for an unknown sale id', async () => {
  await expect(
    ResellerSaleService.sendSaleSms(
      new mongoose.Types.ObjectId().toString(),
      new mongoose.Types.ObjectId().toString(),
    )
  ).rejects.toThrow(/not found/i);
});
