import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';

// Mock MoMo + SMS before importing the services (same pattern as the other
// reseller-sale tests) so cash sales mint without external calls.
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
    sendTicketConfirmation: (...a: any[]) => mockSendTicketConfirmation(...a),
    sendOtp: jest.fn(),
  },
}));

import { ResellerSaleService } from '@services/resellerSale.service';
import { ResellerReportService } from '@services/resellerReport.service';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(() => mockSendTicketConfirmation.mockResolvedValue(true));
afterEach(() => {
  mockMomoInstance.isConfigured.mockReset();
  mockSendTicketConfirmation.mockReset();
});

async function cashSale(resellerId: string, hubId: string) {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 50 });
  const sale = await ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(),
    resellerId,
    hubId,
    eventId,
    items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
    paymentMethod: 'cash',
    customerPhone: '+26878422613',
  });
  return { sale, eventId };
}

it('listSales/summary are scoped to the reseller — no cross-reseller leakage', async () => {
  await PaymentConfigService.update({
    cashEnabled: true,
    defaultResellerCommissionPercent: 0,
    platformFeePercent: 0,
  });
  const a = await Reseller.create({ businessName: 'A', commissionPercent: null });
  const b = await Reseller.create({ businessName: 'B', commissionPercent: null });
  const hubA = new mongoose.Types.ObjectId().toString();

  await cashSale(a._id.toString(), hubA);
  await cashSale(a._id.toString(), hubA);
  await cashSale(b._id.toString(), new mongoose.Types.ObjectId().toString());

  const list = await ResellerReportService.listSales({
    scope: { resellerId: a._id.toString(), role: 'reseller_admin' },
  });
  expect(list.total).toBe(2);

  const sum = await ResellerReportService.summary({
    scope: { resellerId: a._id.toString(), role: 'reseller_admin' },
  });
  expect(sum.totals.salesCount).toBe(2);
  expect(sum.totals.revenue).toBe(200);
});

it('hub_manager only sees their own hub', async () => {
  await PaymentConfigService.update({
    cashEnabled: true,
    defaultResellerCommissionPercent: 0,
    platformFeePercent: 0,
  });
  const r = await Reseller.create({ businessName: 'HubScoped', commissionPercent: null });
  const hub1 = new mongoose.Types.ObjectId().toString();
  const hub2 = new mongoose.Types.ObjectId().toString();

  await cashSale(r._id.toString(), hub1);
  await cashSale(r._id.toString(), hub2);

  const list = await ResellerReportService.listSales({
    scope: { resellerId: r._id.toString(), role: 'reseller_hub_manager', hubId: hub1 },
  });
  expect(list.total).toBe(1);
});

it('summary narrows to a single event when eventId is provided', async () => {
  await PaymentConfigService.update({
    cashEnabled: true,
    defaultResellerCommissionPercent: 0,
    platformFeePercent: 0,
  });
  const r = await Reseller.create({ businessName: 'EventFilterSummary', commissionPercent: null });
  const hub = new mongoose.Types.ObjectId().toString();

  // Two sales for the same reseller but two DIFFERENT events (each cashSale
  // seeds its own event).
  const { eventId: eventA } = await cashSale(r._id.toString(), hub);
  await cashSale(r._id.toString(), hub);

  // No filter → both events counted.
  const all = await ResellerReportService.summary({
    scope: { resellerId: r._id.toString(), role: 'reseller_admin' },
  });
  expect(all.totals.salesCount).toBe(2);
  expect(all.totals.revenue).toBe(200);

  // eventId filter → only that event's single sale.
  const scoped = await ResellerReportService.summary({
    scope: { resellerId: r._id.toString(), role: 'reseller_admin' },
    eventId: eventA,
  });
  expect(scoped.totals.salesCount).toBe(1);
  expect(scoped.totals.revenue).toBe(100);
});

it('listSales narrows to a single event when eventId is provided', async () => {
  await PaymentConfigService.update({
    cashEnabled: true,
    defaultResellerCommissionPercent: 0,
    platformFeePercent: 0,
  });
  const r = await Reseller.create({ businessName: 'EventFilterList', commissionPercent: null });
  const hub = new mongoose.Types.ObjectId().toString();

  const { eventId: eventA } = await cashSale(r._id.toString(), hub);
  await cashSale(r._id.toString(), hub);

  const list = await ResellerReportService.listSales({
    scope: { resellerId: r._id.toString(), role: 'reseller_admin' },
    eventId: eventA,
  });
  expect(list.total).toBe(1);
});
