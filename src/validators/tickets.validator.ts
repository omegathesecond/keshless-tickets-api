import Joi from 'joi';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { EventStatus } from '@interfaces/event.interface';
import { EVENT_CATEGORIES } from '@/constants/eventCategories';
import { TicketStatus, PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { OperatorType } from '@interfaces/vendor.interface';
import { STARTING_PRICE_UNITS } from '@/constants/serviceCategories';
import { isValidPhone } from '@utils/phone.util';

// Cross-field guard: a max price, when both are present, must be >= the min.
const priceRangeCheck = (value: any, helpers: any) => {
  if (value.priceMin != null && value.priceMax != null && value.priceMax < value.priceMin) {
    return helpers.message('Maximum price must be greater than or equal to minimum price');
  }
  return value;
};

/**
 * Authentication Validators
 */
export const loginSchema = Joi.object({
  identifier: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Email, phone number, or username is required',
      'any.required': 'Email, phone number, or username is required'
    }),
  password: Joi.string()
    .required()
    .min(6)
    .messages({
      'string.empty': 'Password is required',
      'any.required': 'Password is required',
      'string.min': 'Password must be at least 6 characters'
    })
});

/**
 * Step 1 of self-service organizer signup: request a verification code. At
 * least one of email / phoneNumber is required — the code goes to the email if
 * present, else the phone (see TicketsAuthService.signupIdentifier).
 */
export const requestRegistrationOtpSchema = Joi.object({
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional()
}).or('email', 'phoneNumber').messages({
  'object.missing': 'An email address or phone number is required'
});

/**
 * Step 2 of self-service organizer signup. At least one of email / phoneNumber
 * is required (mirrors the Vendor model, where both are sparse-unique and
 * either can be the login identifier), plus the 6-digit code from step 1.
 */
export const registerSchema = Joi.object({
  businessName: Joi.string()
    .required()
    .trim()
    .max(100)
    .messages({
      'string.empty': 'Business / organizer name is required',
      'any.required': 'Business / organizer name is required',
      'string.max': 'Business name cannot exceed 100 characters'
    }),
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional(),
  password: Joi.string()
    .required()
    .min(6)
    .messages({
      'string.empty': 'Password is required',
      'any.required': 'Password is required',
      'string.min': 'Password must be at least 6 characters'
    }),
  code: Joi.string()
    .required()
    .pattern(/^\d{6}$/)
    .messages({
      'string.empty': 'Enter the 6-digit code we sent you',
      'any.required': 'Enter the 6-digit code we sent you',
      'string.pattern.base': 'Enter the 6-digit code we sent you'
    }),
  businessType: Joi.string()
    .valid('event_organizer', 'venue', 'promoter', 'entertainment', 'sports', 'other')
    .optional(),
  primaryContact: Joi.string().trim().max(100).optional()
}).or('email', 'phoneNumber').messages({
  'object.missing': 'An email address or phone number is required'
});

/**
 * Self-service SERVICES (event supplier) business signup. Mirrors registerSchema's
 * OTP-gated shape but replaces businessType/primaryContact with the services
 * fields (serviceCategory required, startingPrice/city optional).
 */
export const businessRegisterSchema = Joi.object({
  businessName: Joi.string().required().trim().max(100).messages({
    'string.empty': 'Business name is required',
    'any.required': 'Business name is required',
  }),
  // Membership in the active category set is DB-driven now (not a hardcoded
  // enum) — checked by ServiceCategoryService.isValidActive in
  // TicketsAuthService.registerBusiness, which throws the same
  // 'Choose a valid service category' message this validator used to.
  serviceCategory: Joi.string().trim().required().messages({
    'string.empty': 'Choose a service category',
    'any.required': 'Choose a service category',
  }),
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional(),
  password: Joi.string().required().min(6),
  code: Joi.string().required().pattern(/^\d{6}$/).messages({
    'string.pattern.base': 'Enter the 6-digit code we sent you',
  }),
  city: Joi.string().trim().max(100).optional(),
  startingPrice: Joi.object({
    amountCents: Joi.number().integer().min(0).required(),
    unit: Joi.string().valid(...STARTING_PRICE_UNITS).default('day'),
  }).optional(),
}).or('email', 'phoneNumber').messages({ 'object.missing': 'An email address or phone number is required' });

/**
 * Admin-only operator creation (POST /admin/organizers). Unlike registerSchema
 * this REQUIRES operatorType — self-signup never gets to choose transport/both,
 * only a super-admin minting the account directly can set it.
 */
export const createOrganizerSchema = Joi.object({
  businessName: Joi.string().trim().min(2).max(100).required(),
  operatorType: Joi.string().valid(...Object.values(OperatorType)).required(),
  email: Joi.string().email().trim().lowercase().optional(),
  phoneNumber: Joi.string().trim().max(20).optional(),
  password: Joi.string().min(6).required(),
  businessType: Joi.string().trim().optional(),
  primaryContact: Joi.string().trim().max(100).optional(),
}).or('email', 'phoneNumber');

export const updateProfileSchema = Joi.object({
  firstName: Joi.string().trim().max(50).optional(),
  lastName: Joi.string().trim().max(50).optional(),
  email: Joi.string().email().trim().optional(),
  phoneNumber: Joi.string().trim().optional(),
  businessName: Joi.string().trim().max(100).optional()
}).min(1).messages({
  'object.min': 'At least one field must be provided for update'
});

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string()
    .required()
    .messages({
      'string.empty': 'Current password is required',
      'any.required': 'Current password is required'
    }),
  newPassword: Joi.string()
    .required()
    .min(6)
    .messages({
      'string.empty': 'New password is required',
      'any.required': 'New password is required',
      'string.min': 'New password must be at least 6 characters'
    })
});

/**
 * Self-service organizer password reset (no auth). Step 1 asks for the email
 * or phone the account was created with; step 2 supplies the 6-digit code plus
 * the new password. Kept separate from changePasswordSchema, which requires the
 * CURRENT password (an authenticated change, not an ownership-proof reset).
 */
export const forgotPasswordSchema = Joi.object({
  identifier: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Enter the email or phone number for your account',
      'any.required': 'Enter the email or phone number for your account'
    })
});

export const resetPasswordSchema = Joi.object({
  identifier: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Enter the email or phone number for your account',
      'any.required': 'Enter the email or phone number for your account'
    }),
  code: Joi.string()
    .required()
    .pattern(/^\d{6}$/)
    .messages({
      'string.empty': 'Enter the 6-digit code we sent you',
      'any.required': 'Enter the 6-digit code we sent you',
      'string.pattern.base': 'Enter the 6-digit code we sent you'
    }),
  newPassword: Joi.string()
    .required()
    .min(6)
    .messages({
      'string.empty': 'New password is required',
      'any.required': 'New password is required',
      'string.min': 'New password must be at least 6 characters'
    })
});

/**
 * Event Validators
 */
export const createEventSchema = Joi.object({
  name: Joi.string()
    .required()
    .trim()
    .max(200)
    .messages({
      'string.empty': 'Event name is required',
      'any.required': 'Event name is required',
      'string.max': 'Event name cannot exceed 200 characters'
    }),
  description: Joi.string()
    .optional()
    .max(2000)
    .messages({
      'string.max': 'Description cannot exceed 2000 characters'
    }),
  venue: Joi.string()
    .required()
    .trim()
    .max(200)
    .messages({
      'string.empty': 'Venue is required',
      'any.required': 'Venue is required',
      'string.max': 'Venue cannot exceed 200 characters'
    }),
  eventDate: Joi.date()
    .required()
    .min('now')
    .messages({
      'any.required': 'Event date is required',
      'date.min': 'Event date must be in the future'
    }),
  startTime: Joi.date()
    .required()
    .messages({
      'any.required': 'Start time is required'
    }),
  endTime: Joi.date()
    .required()
    .min(Joi.ref('startTime'))
    .messages({
      'any.required': 'End time is required',
      'date.min': 'End time must be after start time'
    }),
  isMultiDay: Joi.boolean()
    .optional()
    .default(false)
    .messages({
      'boolean.base': 'isMultiDay must be a boolean value'
    }),
  // Whether NFC tap-and-go wallet/POS is enabled for this event (cashless
  // spec §11). Optional — omitting it lets the Event model default (false)
  // apply, same as isMultiDay above.
  cashless: Joi.boolean()
    .optional()
    .messages({
      'boolean.base': 'cashless must be a boolean value'
    }),
  category: Joi.string().valid(...EVENT_CATEGORIES).default('Other').messages({
    'any.only': 'Invalid event category'
  }),
  posterUrl: Joi.string().uri().optional().trim().messages({
    'string.uri': 'Poster URL must be a valid URL'
  }),
  thumbnailUrl: Joi.string().uri().optional().trim().messages({
    'string.uri': 'Thumbnail URL must be a valid URL'
  }),
  galleryImages: Joi.array().items(Joi.string().uri()).optional().messages({
    'string.uri': 'Gallery image URLs must be valid URLs'
  }),
  qrCodeUrl: Joi.string().uri().optional().trim().messages({
    'string.uri': 'QR Code URL must be a valid URL'
  }),
  // Capacity is optional — it is derived from the sum of ticket-type
  // quantities server-side (see event.model pre-save hook). Accepted if sent
  // for backward compatibility, but never required at event creation.
  capacity: Joi.number()
    .min(0)
    .max(1000000)
    .optional()
    .messages({
      'number.min': 'Capacity cannot be negative',
      'number.max': 'Capacity cannot exceed 1,000,000'
    }),
  ticketTypes: Joi.array()
    .optional()
    .items(
      Joi.object({
        name: Joi.string().required().trim().max(100).messages({
          'any.required': 'Ticket type name is required',
          'string.max': 'Ticket type name cannot exceed 100 characters'
        }),
        description: Joi.string().optional().max(500).messages({
          'string.max': 'Ticket type description cannot exceed 500 characters'
        }),
        price: Joi.number().required().min(0).messages({
          'any.required': 'Price is required',
          'number.min': 'Price cannot be negative'
        }),
        quantity: Joi.number().required().min(1).messages({
          'any.required': 'Quantity is required',
          'number.min': 'Quantity must be at least 1'
        }),
        isSoldOut: Joi.boolean().optional().messages({
          'boolean.base': 'isSoldOut must be a boolean value'
        })
      })
    )
    .default([]),
  ticketing: Joi.string().valid('carrot', 'external').default('carrot').messages({
    'any.only': "Ticketing must be either 'carrot' or 'external'"
  }),
  externalTicketUrl: Joi.string().uri({ scheme: ['https'] }).when('ticketing', {
    is: 'external', then: Joi.required(), otherwise: Joi.optional().allow('', null),
  }).messages({
    'string.uri': 'External ticket URL must be a valid https:// URL',
    'any.required': 'External ticket URL is required when ticketing is set to external'
  }),
  currency: Joi.string().valid('SZL', 'ZAR').default('SZL').messages({
    'any.only': "Currency must be either 'SZL' or 'ZAR'",
  }),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  // Vote feature inputs — see event.model.ts. Optional; absent skips the
  // question they gate (artist / outfit-theme voting) entirely.
  lineup: Joi.array().items(Joi.string().trim().max(100)).max(50).optional(),
  outfitThemeOptions: Joi.array().items(Joi.string().trim().max(60)).max(20).optional(),
}).custom(priceRangeCheck);

export const updateEventSchema = Joi.object({
  name: Joi.string().trim().max(200).optional(),
  description: Joi.string().max(2000).optional(),
  venue: Joi.string().trim().max(200).optional(),
  eventDate: Joi.date().min('now').optional(),
  startTime: Joi.date().optional(),
  endTime: Joi.date().optional(),
  isMultiDay: Joi.boolean().optional(),
  // See createEventSchema.cashless — optional, false unsets it.
  cashless: Joi.boolean()
    .optional()
    .messages({
      'boolean.base': 'cashless must be a boolean value'
    }),
  category: Joi.string().valid(...EVENT_CATEGORIES).messages({
    'any.only': 'Invalid event category'
  }),
  posterUrl: Joi.string().uri().optional().trim(),
  thumbnailUrl: Joi.string().uri().optional().trim(),
  galleryImages: Joi.array().items(Joi.string().uri()).optional(),
  qrCodeUrl: Joi.string().uri().optional().trim(),
  capacity: Joi.number().min(1).max(1000000).optional(),
  ticketTypes: Joi.array()
    .items(
      Joi.object({
        // Echo back the tier's own id to edit it in place. Without it a tier is
        // matched by name, so a rename reads as delete-then-recreate and the
        // tier loses its sold count (and its identity, which issued tickets
        // point at). Omit only for a genuinely new tier.
        _id: Joi.string().hex().length(24).optional(),
        name: Joi.string().required().trim().max(100),
        description: Joi.string().optional().max(500),
        price: Joi.number().required().min(0),
        quantity: Joi.number().required().min(1),
        isSoldOut: Joi.boolean().optional()
      })
    )
    .optional(),
  ticketing: Joi.string().valid('carrot', 'external').messages({
    'any.only': "Ticketing must be either 'carrot' or 'external'"
  }),
  externalTicketUrl: Joi.string().uri({ scheme: ['https'] }).when('ticketing', {
    is: 'external', then: Joi.required(), otherwise: Joi.optional().allow('', null),
  }).messages({
    'string.uri': 'External ticket URL must be a valid https:// URL',
    'any.required': 'External ticket URL is required when ticketing is set to external'
  }),
  currency: Joi.string().valid('SZL', 'ZAR').optional().messages({
    'any.only': "Currency must be either 'SZL' or 'ZAR'",
  }),
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),
  lineup: Joi.array().items(Joi.string().trim().max(100)).max(50).optional(),
  outfitThemeOptions: Joi.array().items(Joi.string().trim().max(60)).max(20).optional(),
}).min(1).custom(priceRangeCheck).messages({
  'object.min': 'At least one field must be provided for update'
});

export const eventQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid(...Object.values(EventStatus)).optional(),
  startDate: Joi.date().iso().optional(),
  // `min(startDate)` only applies when startDate is ALSO present — an
  // endDate-only query must not 400 trying to resolve a ref to a field
  // that isn't there.
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }).messages({
    'date.min': 'End date must be after start date'
  }),
  search: Joi.string().optional(),
  // Platform-staff-only narrowing: pick one organizer's catalogue while acting
  // on their behalf. Silently ignored for everyone else, whose own vendorId
  // already scopes the query.
  vendorId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).optional()
});

/**
 * Ticket Sales Validators
 */
export const sellTicketSchema = Joi.object({
  eventId: Joi.string()
    .required()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.empty': 'Event ID is required',
      'any.required': 'Event ID is required',
      'string.pattern.base': 'Invalid event ID format'
    }),
  // A basket, or the legacy single-tier pair. Box-office staff ring up
  // several tiers for one customer, and the dashboard ships separately from
  // this API, so both shapes are accepted (see the controller's normalisation).
  items: Joi.array()
    .items(Joi.object({
      ticketTypeId: Joi.string().required().trim(),
      quantity: Joi.number().required().min(1).max(100),
      // Optional, sparse, applied in order to this line's tickets. Shorter than
      // quantity is fine — the rest fall back to the sale's buyer details.
      recipients: Joi.array()
        .items(Joi.object({
          name: Joi.string().trim().max(120).optional(),
          phone: Joi.string().trim().max(32).optional().custom((value, helpers) => {
            if (!isValidPhone(value)) return helpers.error('any.invalid');
            return value;
          }).messages({
            'any.invalid': 'phone must be a valid phone number',
          }),
          email: Joi.string().trim().email().max(254).optional(),
        }))
        .optional()
        .max(100),
    }).custom((value, helpers) => {
      if (Array.isArray(value.recipients) && value.recipients.length > value.quantity) {
        return helpers.error('any.invalid');
      }
      return value;
    }).messages({
      'any.invalid': 'Cannot supply more recipients than the quantity for a ticket type',
    }))
    .min(1)
    .max(20)
    .optional(),
  ticketTypeId: Joi.string()
    .optional()
    .trim(),
  quantity: Joi.number()
    .optional()
    .min(1)
    .max(100)
    .messages({
      'number.min': 'Quantity must be at least 1',
      'number.max': 'Cannot sell more than 100 tickets at once'
    }),
  customerName: Joi.string()
    .optional()
    .trim()
    .max(100)
    .messages({
      'string.max': 'Customer name cannot exceed 100 characters'
    }),
  customerPhone: Joi.string()
    .optional()
    .trim()
    .messages({
      'string.max': 'Customer phone cannot exceed 20 characters'
    }),
  paymentMethod: Joi.string()
    .required()
    .valid(...Object.values(PaymentMethod))
    .messages({
      'string.empty': 'Payment method is required',
      'any.required': 'Payment method is required',
      'any.only': 'Invalid payment method'
    }),
  keshlessCardNumber: Joi.when('paymentMethod', {
    is: PaymentMethod.KESHLESS_WALLET,
    then: Joi.string()
      .required()
      .length(8)
      .pattern(/^[A-Z0-9]+$/)
      .messages({
        'any.required': 'Card number is required for Keshless wallet payment',
        'string.length': 'Card number must be exactly 8 characters',
        'string.pattern.base': 'Card number must be alphanumeric (uppercase)'
      }),
    otherwise: Joi.optional()
  }),
  keshlessPin: Joi.when('paymentMethod', {
    is: PaymentMethod.KESHLESS_WALLET,
    then: Joi.string()
      .optional()
      .length(4)
      .pattern(/^[0-9]{4}$/)
      .messages({
        'string.length': 'PIN must be exactly 4 digits',
        'string.pattern.base': 'PIN must contain only numbers'
      }),
    otherwise: Joi.optional()
  })
}).or('items', 'ticketTypeId');

export const refundTicketSchema = Joi.object({
  reason: Joi.string()
    .optional()
    .max(500)
    .messages({
      'string.max': 'Reason cannot exceed 500 characters'
    })
});

/**
 * Query for GET /tickets/export/sales.
 *
 * Same filter vocabulary as ticketSalesQuerySchema minus paging — the CSV is
 * the whole result set, not a page. Validated rather than passed straight
 * through so a bad value (a typo'd channel, a stale enum from an old client)
 * gets a 400 instead of quietly producing an EMPTY CSV that looks like
 * "no sales matched" — the export people reconcile their money against.
 */
export const ticketSalesExportQuerySchema = Joi.object({
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
  paymentStatus: Joi.string().valid(...Object.values(PaymentStatus)).optional(),
  channel: Joi.string().valid(...Object.values(SalesChannel)).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }).messages({
    'date.min': 'End date must be after start date'
  })
});

export const ticketSalesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  paymentMethod: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
  paymentStatus: Joi.string().valid(...Object.values(PaymentStatus)).optional(),
  channel: Joi.string().valid(...Object.values(SalesChannel)).optional(),
  startDate: Joi.date().iso().optional(),
  // `min(startDate)` only applies when startDate is ALSO present — an
  // endDate-only query must not 400 trying to resolve a ref to a field
  // that isn't there.
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }).messages({
    'date.min': 'End date must be after start date'
  })
});

/**
 * Scan Validators
 */
export const validateTicketSchema = Joi.object({
  ticketId: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Ticket ID is required',
      'any.required': 'Ticket ID is required'
    }),
  // Optional gate guard: when the operator has selected a specific event to
  // scan for, the client sends it here so the API rejects tickets belonging to
  // any other show ("wrong event") instead of silently accepting them.
  expectedEventId: Joi.string()
    .optional()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({ 'string.pattern.base': 'Invalid event ID' })
});

// Gate check-in accepts EITHER a scanned QR/short-code ticketId OR a tapped
// cashless band uid (cashless spec §5.1) — never both, never neither. bandUid
// uses the same 8-hex (4-byte) minimum as bindBandSchema/reissueBandSchema.
export const checkInTicketSchema = Joi.object({
  ticketId: Joi.string()
    .trim()
    .messages({
      'string.empty': 'Ticket ID is required'
    }),
  bandUid: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[0-9a-f]{8,}$/)
    .messages({
      'string.empty': 'Band UID is required',
      'string.pattern.base': 'Band UID must be at least 4 bytes (8 hex chars)'
    }),
  expectedEventId: Joi.string()
    .optional()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({ 'string.pattern.base': 'Invalid event ID' }),
  notes: Joi.string()
    .optional()
    .max(500)
    .messages({
      'string.max': 'Notes cannot exceed 500 characters'
    })
}).xor('ticketId', 'bandUid').messages({
  'object.xor': 'Provide exactly one of ticketId or bandUid'
});

// Band binding is a dedicated band-desk action (cashless spec §5.1) — see
// ScanService.bindBandToTicket. bandUid must be a real NFC chip id: 8 hex
// chars = 4 bytes, the minimum real-world UID length (see @utils/bandUid.util
// for the shared normalize/validate logic consumed elsewhere in the system).
export const bindBandSchema = Joi.object({
  ticketId: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Ticket ID is required',
      'any.required': 'Ticket ID is required'
    }),
  bandUid: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[0-9a-f]{8,}$/)
    .required()
    .messages({
      'string.empty': 'Band UID is required',
      'string.pattern.base': 'Band UID must be at least 4 bytes (8 hex chars)',
      'any.required': 'Band UID is required'
    }),
  expectedEventId: Joi.string()
    .optional()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({ 'string.pattern.base': 'Invalid event ID' })
});

// Reissue is the lost-band path (cashless spec §5.1) — see
// ScanService.reissueBandForTicket. `reason` is required so the audit trail
// (BandBinding.unboundReason) always has a true explanation, never a blank.
// newBandUid uses the same 8-hex (4-byte) requirement as bindBandSchema.bandUid.
export const reissueBandSchema = Joi.object({
  ticketId: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Ticket ID is required',
      'any.required': 'Ticket ID is required'
    }),
  newBandUid: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[0-9a-f]{8,}$/)
    .required()
    .messages({
      'string.empty': 'New band UID is required',
      'string.pattern.base': 'New band UID must be at least 4 bytes (8 hex chars)',
      'any.required': 'New band UID is required'
    }),
  reason: Joi.string()
    .required()
    .trim()
    .messages({
      'string.empty': 'Reason is required',
      'any.required': 'Reason is required'
    }),
  expectedEventId: Joi.string()
    .optional()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({ 'string.pattern.base': 'Invalid event ID' })
});

export const scanQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  status: Joi.string().valid('success', 'failed', 'already_scanned').optional(),
  startDate: Joi.date().iso().optional(),
  // `min(startDate)` only applies when startDate is ALSO present — an
  // endDate-only query must not 400 trying to resolve a ref to a field
  // that isn't there.
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }).messages({
    'date.min': 'End date must be after start date'
  })
});

/**
 * Analytics Validators
 */
export const analyticsQuerySchema = Joi.object({
  startDate: Joi.date().iso().optional(),
  // `min(startDate)` only applies when startDate is ALSO present — an
  // endDate-only query must not 400 trying to resolve a ref to a field
  // that isn't there.
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }).messages({
    'date.min': 'End date must be after start date'
  }),
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  groupBy: Joi.string()
    .valid('daily', 'weekly', 'monthly')
    .optional()
    .default('daily')
    .messages({
      'any.only': 'Group by must be daily, weekly, or monthly'
    }),
  channel: Joi.string()
    .valid('online', 'box_office', 'reseller_pos')
    .optional()
    .messages({
      'any.only': 'Channel must be online, box_office, or reseller_pos'
    })
});

/**
 * Access Management Validators
 */
export const grantAccessSchema = Joi.object({
  userId: Joi.string()
    .required()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.empty': 'User ID is required',
      'any.required': 'User ID is required',
      'string.pattern.base': 'Invalid user ID format'
    }),
  role: Joi.string()
    .required()
    .valid(...Object.values(TicketsRole))
    .messages({
      'string.empty': 'Role is required',
      'any.required': 'Role is required',
      'any.only': 'Invalid role'
    }),
  customPermissions: Joi.array()
    .items(Joi.string().valid(...Object.values(TicketsPermission)))
    .optional()
    .messages({
      'array.includes': 'Invalid permission in customPermissions'
    })
});

export const revokeAccessSchema = Joi.object({
  userId: Joi.string()
    .required()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.empty': 'User ID is required',
      'any.required': 'User ID is required',
      'string.pattern.base': 'Invalid user ID format'
    })
});

export const updateAccessSchema = Joi.object({
  userId: Joi.string()
    .required()
    .regex(/^[0-9a-fA-F]{24}$/)
    .messages({
      'string.empty': 'User ID is required',
      'any.required': 'User ID is required',
      'string.pattern.base': 'Invalid user ID format'
    }),
  role: Joi.string()
    .valid(...Object.values(TicketsRole))
    .optional(),
  customPermissions: Joi.array()
    .items(Joi.string().valid(...Object.values(TicketsPermission)))
    .optional()
}).or('role', 'customPermissions').messages({
  'object.missing': 'At least one field (role or customPermissions) must be provided for update'
});


// An organizer's ask for cashless (they may not set the flag themselves — see
// EventService.requestCashless). The note is optional context for Carrot ops.
export const cashlessRequestSchema = Joi.object({
  note: Joi.string().trim().max(300).allow('').optional().messages({
    'string.max': 'Note cannot exceed 300 characters',
  }),
});
