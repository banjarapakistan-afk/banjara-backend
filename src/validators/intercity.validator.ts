import { z } from 'zod';
import { INTERCITY_CLASSES } from '../models/RouteFare';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

const place = z.object({
  address: z.string().trim().min(3).max(300),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

const returnTrip = z.object({
  departAt: z.string().min(1),
  waitMode: z.enum(['hourly', 'overnight']),
  waitHours: z.coerce.number().min(0).max(72).optional(),
  nights: z.coerce.number().int().min(1).max(14).optional(),
});

export const intercityQuoteSchema = z.object({
  pickup: place,
  dropoff: place,
  vehicleClass: z.enum(INTERCITY_CLASSES),
  rideType: z.enum(['full_car', 'shared_seat']).default('full_car'),
  passengers: z.coerce.number().int().min(1).max(30),
  journeyType: z.enum(['one_way', 'round_trip']).default('one_way'),
  returnTrip: returnTrip.optional(),
  /** Price and ask one driver (picked from their card). */
  providerId: objectId.optional(),
  vip: z.boolean().optional(),
});

export const intercityRequestSchema = intercityQuoteSchema.extend({
  bookNow: z.boolean().default(false),
  departAt: z.string().optional(),
  luggage: z
    .object({ bags: z.coerce.number().int().min(0).max(20).default(0), large: z.coerce.number().int().min(0).max(10).default(0) })
    .optional(),
  passengerName: z.string().trim().min(2).max(100),
  passengerPhone: z.string().trim().regex(/^\+?\d{10,15}$/, 'Enter a valid phone number'),
  notes: z.string().trim().max(500).optional(),
  offerAmount: z.coerce.number().int().positive().optional(),
});

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  vehicleClass: z.enum(INTERCITY_CLASSES).optional(),
  radiusKm: z.coerce.number().min(1).max(200).optional(),
});

export const chooseOfferSchema = z.object({ offerId: objectId });

export const joinSharedSchema = z.object({ tripId: objectId });

export const sharedTripsQuerySchema = z.object({
  fromCityId: objectId,
  toCityId: objectId,
  departAt: z.string().min(1),
  passengers: z.coerce.number().int().min(1).max(30).default(1),
});

export const driverSettingsSchema = z.object({
  enabled: z.boolean(),
  homeCityId: objectId.nullable().optional(),
  preferredRoutes: z.array(z.object({ fromCityId: objectId, toCityId: objectId })).max(20).optional(),
  acceptsShared: z.boolean().optional(),
});

export const respondSchema = z.object({
  action: z.enum(['accept', 'decline', 'counter']),
  amount: z.coerce.number().int().positive().optional(),
  vehicleId: objectId.optional(),
  /** Cost pricing: one of the driver's three prices (the server works out the amount). */
  level: z.enum(['saver', 'standard', 'premium']).optional(),
});

export const tripStatusSchema = z.object({ status: z.enum(['departed', 'completed']) });

const PAY_CHANNELS = ['bank', 'easypaisa', 'jazzcash', 'raast', 'other'] as const;

/** A driver reports paying BANJARA its City to City commission. */
export const commissionPaymentSchema = z.object({
  amount: z.coerce.number().int().positive().max(10_000_000),
  channel: z.enum(PAY_CHANNELS),
  reference: z.string().trim().min(4, 'Enter the transaction ID from your receipt').max(80),
  note: z.string().trim().max(300).optional(),
});

export const reviewCommissionPaymentSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const commissionSettingsSchema = z.object({
  commissionPercent: z.coerce.number().min(0).max(100).optional(),
  maxDriverDue: z.coerce.number().int().min(0).max(10_000_000).optional(),
  maxDueDays: z.coerce.number().int().min(0).max(365).optional(),
  collectionAccounts: z
    .array(
      z.object({
        channel: z.enum(PAY_CHANNELS),
        accountTitle: z.string().trim().min(2).max(100),
        accountNumber: z.string().trim().min(4).max(60),
        note: z.string().trim().max(200).optional(),
      })
    )
    .max(10)
    .optional(),
});

export const locationBatchSchema = z.object({
  points: z
    .array(
      z.object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        at: z.string().min(1),
        speed: z.coerce.number().min(0).max(100).optional(),
        heading: z.coerce.number().min(0).max(360).optional(),
      })
    )
    .min(1)
    .max(500),
});

/* Cost-based pricing ------------------------------------------------ */

const money = z.coerce.number().min(0).max(1_000_000);

const classCostInput = z.object({
  fuelType: z.enum(['petrol', 'diesel']).optional(),
  kmPerLitre: z.coerce.number().min(1).max(60).optional(),
  maintenance: money.optional(),
  labour: money.optional(),
  insurance: money.optional(),
});

/** Admin: fuel prices, app fee, VIP and the class defaults. */
export const pricingSettingsSchema = z.object({
  pricingMode: z.enum(['formula', 'cost']).optional(),
  fuelPrices: z.object({ petrol: z.coerce.number().min(1).max(5000).optional(), diesel: z.coerce.number().min(1).max(5000).optional() }).optional(),
  appFeePerPassenger: money.optional(),
  vipCharge: money.optional(),
  saverPercent: z.coerce.number().min(0).max(90).optional(),
  premiumPercent: z.coerce.number().min(0).max(90).optional(),
  maxLevelPercent: z.coerce.number().min(0).max(90).optional(),
  classCosts: z.object(Object.fromEntries(INTERCITY_CLASSES.map((k) => [k, classCostInput.optional()])) as Record<(typeof INTERCITY_CLASSES)[number], z.ZodOptional<typeof classCostInput>>).optional(),
});

/** Driver: their own costs for one vehicle; null puts a field back to BANJARA's default. */
export const vehiclePricingSchema = z.object({
  fuelType: z.enum(['petrol', 'diesel']).nullable().optional(),
  kmPerLitre: z.coerce.number().min(1).max(60).nullable().optional(),
  maintenance: money.nullable().optional(),
  labour: money.nullable().optional(),
  insurance: money.nullable().optional(),
  vipCharge: money.nullable().optional(),
  saverPercent: z.coerce.number().min(0).max(90).nullable().optional(),
  premiumPercent: z.coerce.number().min(0).max(90).nullable().optional(),
});
