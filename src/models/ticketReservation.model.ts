import mongoose, { Schema } from 'mongoose';

/** One tier's share of a hold. A single-tier sale has exactly one. */
export interface IReservationLine {
  ticketTypeId: string;
  quantity: number;
}

export interface ITicketReservation extends mongoose.Document {
  eventId: mongoose.Types.ObjectId;
  /**
   * Every tier this sale is holding inventory on. An array rather than one
   * document per line so `saleId` can stay unique — confirm(saleId) and
   * release(saleId) are idempotent precisely because they resolve to a single
   * document, and splitting per line would turn both into multi-document
   * operations that can half-apply.
   */
  lines: IReservationLine[];
  saleId: mongoose.Types.ObjectId;
  expiresAt: Date;
  status: 'held' | 'confirmed' | 'released';
}

const lineSchema = new Schema<IReservationLine>({
  ticketTypeId: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const schema = new Schema<ITicketReservation>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  lines: {
    type: [lineSchema],
    required: true,
    validate: [(v: IReservationLine[]) => Array.isArray(v) && v.length > 0, 'a reservation needs at least one line'],
  },
  saleId: { type: Schema.Types.ObjectId, ref: 'TicketSale', required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['held', 'confirmed', 'released'], default: 'held', index: true },
}, { timestamps: true });

export const TicketReservation = mongoose.model<ITicketReservation>('TicketReservation', schema);
