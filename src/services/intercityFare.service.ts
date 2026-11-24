import {
  IntercitySettings,
  DEFAULT_INTERCITY_SETTINGS,
  type ClassCost,
  type FuelType,
  type IIntercitySettings,
} from '../models/IntercitySettings';
import { RouteFare, type IRouteFare, type IntercityClass } from '../models/RouteFare';
import type { IVehicleCostProfile } from '../models/Vehicle';

/**
 * City to City fare strategy. It only works out the ride subtotal (what the driver
 * earns before BANJARA's tax and service fee); booking.service's calcPricing adds those
 * exactly as for every other booking, so the existing pricing is untouched.
 */

export type FareSettings = Pick<
  IIntercitySettings,
  | 'baseFare'
  | 'ratePerKm'
  | 'ratePerMinute'
  | 'minimumFare'
  | 'roadFactor'
  | 'fallbackSpeedKmh'
  | 'classMultipliers'
  | 'sharedSeatFraction'
  | 'waitingPerHour'
  | 'overnightCharge'
  | 'bidOnFallback'
>;

/** Route facts used by the formula (the row's stored price, if any, is ignored). */
export type FareRoute = Pick<IRouteFare, 'distanceKm' | 'durationMinutes' | 'tolls' | 'difficultSurcharge' | 'bidEnabled'>;

export type ReturnWait = { mode: 'hourly'; hours: number } | { mode: 'overnight'; nights: number };

export interface FareInput {
  vehicleClass: IntercityClass;
  rideType: 'full_car' | 'shared_seat';
  /** Shared rides: seats booked. Ignored for a full car. */
  seats?: number;
  /** Door-to-door straight-line km; used when the route has no fixed fare. */
  straightLineKm: number;
  route?: FareRoute | null;
  /** Round trip: how the driver waits before the return leg. */
  returnWait?: ReturnWait | null;
}

export interface FareLine {
  code:
    | 'base'
    | 'distance'
    | 'time'
    | 'minimum'
    | 'tolls'
    | 'difficult_route'
    | 'return_leg'
    | 'waiting'
    | 'overnight'
    | 'shared_seats'
    // Cost-based fares:
    | 'fuel'
    | 'pickup'
    | 'maintenance'
    | 'labour'
    | 'insurance'
    | 'vip'
    | 'app_fee';
  label: string;
  amount: number;
}

/** A driver's three prices for a request. */
export const PRICE_LEVELS = ['saver', 'standard', 'premium'] as const;
export type PriceLevel = (typeof PRICE_LEVELS)[number];

export interface FareQuote {
  /** Where km and time came from: a known route, or an estimate from straight-line distance. */
  source: 'route' | 'formula';
  distanceKm: number;
  durationMinutes: number;
  lines: FareLine[];
  /** Outbound leg (incl. its extras). */
  outbound: number;
  /** Return leg + waiting/overnight; 0 for one-way. */
  returnLeg: number;
  subtotal: number;
  /** Riders may offer their own price. */
  bidAllowed: boolean;
  /** Which formula priced this quote (missing on quotes saved before cost pricing). */
  pricing?: 'formula' | 'cost';
  /** Cost pricing: km the driver drives to reach the pickup (0 when no driver is known yet). */
  pickupKm?: number;
  /** Cost pricing: BANJARA's app fee inside the subtotal. */
  appFee?: number;
  /** Cost pricing: the Saver / Standard / Premium prices (standard = subtotal). */
  levels?: Record<PriceLevel, number>;
}

/** Fares are quoted in whole tens of rupees. */
const roundFare = (value: number) => Math.round(value / 10) * 10;

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** "960" -> "16 h", "150" -> "2 h 30 min". */
function durationLabel(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/**
 * Pure: the fare for one request.
 *
 *   F = max(minimumFare, baseFare + km × ratePerKm + minutes × ratePerMinute) × class + tolls + surcharge
 *
 * Road km and drive time come from the route when known, otherwise from the straight-line
 * distance (× roadFactor) at fallbackSpeedKmh. Each line is rounded to Rs 10 and the fare
 * is their sum, so the breakdown always adds up to the total.
 */
export function computeFare(input: FareInput, settings: FareSettings): FareQuote {
  const multiplier = settings.classMultipliers[input.vehicleClass] ?? 1;
  const route = input.route ?? null;
  const distanceKm = route?.distanceKm || Math.round(input.straightLineKm * settings.roadFactor);
  const durationMinutes =
    route?.durationMinutes || Math.round((distanceKm / Math.max(5, settings.fallbackSpeedKmh)) * 60);

  const base = roundFare(settings.baseFare * multiplier);
  const distance = roundFare(distanceKm * settings.ratePerKm * multiplier);
  const time = roundFare(durationMinutes * settings.ratePerMinute * multiplier);
  const lines: FareLine[] = [
    { code: 'base', label: 'Base fare', amount: base },
    { code: 'distance', label: `${distanceKm} km`, amount: distance },
    { code: 'time', label: `About ${durationLabel(durationMinutes)} driving`, amount: time },
  ];
  // Short trips still cost the driver most of a day: never go below the minimum fare.
  const minimum = roundFare(settings.minimumFare * multiplier);
  const formula = base + distance + time;
  if (formula < minimum) lines.push({ code: 'minimum', label: 'Minimum fare top-up', amount: minimum - formula });
  if (route && route.tolls > 0) lines.push({ code: 'tolls', label: 'Tolls', amount: roundFare(route.tolls) });
  if (route && route.difficultSurcharge > 0) {
    lines.push({ code: 'difficult_route', label: 'Rough road surcharge', amount: roundFare(route.difficultSurcharge) });
  }
  const leg = lines.reduce((sum, line) => sum + line.amount, 0);

  let returnLeg = 0;
  if (input.returnWait) {
    lines.push({ code: 'return_leg', label: 'Return journey', amount: leg });
    returnLeg += leg;
    if (input.returnWait.mode === 'hourly') {
      const hours = Math.max(0, Math.ceil(input.returnWait.hours));
      if (hours > 0) {
        const waiting = roundFare(settings.waitingPerHour * hours);
        lines.push({ code: 'waiting', label: `Driver waits ${hours} h`, amount: waiting });
        returnLeg += waiting;
      }
    } else {
      const nights = Math.max(1, Math.ceil(input.returnWait.nights));
      const overnight = roundFare(settings.overnightCharge * nights);
      lines.push({ code: 'overnight', label: `Driver stays ${nights} night${nights === 1 ? '' : 's'}`, amount: overnight });
      returnLeg += overnight;
    }
  }

  let outbound = leg;
  if (input.rideType === 'shared_seat') {
    // A shared seat is a fraction of the full-car fare, per seat. (Round trips are
    // full-car only, so there is never a return leg here.)
    const seats = Math.max(1, Math.floor(input.seats ?? 1));
    const perSeat = roundFare(leg * settings.sharedSeatFraction);
    lines.splice(0, lines.length, { code: 'shared_seats', label: `${seats} × shared seat`, amount: perSeat * seats });
    outbound = perSeat * seats;
    returnLeg = 0;
  }

  return {
    source: route ? 'route' : 'formula',
    distanceKm,
    durationMinutes,
    lines,
    outbound,
    returnLeg,
    subtotal: outbound + returnLeg,
    bidAllowed: input.route ? input.route.bidEnabled : settings.bidOnFallback,
    pricing: 'formula',
  };
}

/* ------------------------------------------------------------------ */
/* Cost-based fares                                                    */
/* ------------------------------------------------------------------ */

export type CostSettings = Pick<
  IIntercitySettings,
  | 'roadFactor'
  | 'fallbackSpeedKmh'
  | 'sharedSeatFraction'
  | 'waitingPerHour'
  | 'overnightCharge'
  | 'bidOnFallback'
  | 'fuelPrices'
  | 'appFeePerPassenger'
  | 'vipCharge'
  | 'classCosts'
  | 'saverPercent'
  | 'premiumPercent'
  | 'maxLevelPercent'
>;

/** One vehicle's costs: the driver's own where set, BANJARA's class defaults otherwise. */
export interface ResolvedCosts extends ClassCost {
  /** PKR per litre of this vehicle's fuel. */
  fuelPrice: number;
  vipCharge: number;
  saverPercent: number;
  premiumPercent: number;
  /** True when the driver has set any of their own costs. */
  custom: boolean;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Pure: a vehicle's costs from the class defaults and the driver's own profile. */
export function resolveCosts(
  settings: Pick<CostSettings, 'classCosts' | 'fuelPrices' | 'vipCharge' | 'saverPercent' | 'premiumPercent' | 'maxLevelPercent'>,
  vehicleClass: IntercityClass,
  profile?: IVehicleCostProfile | null
): ResolvedCosts {
  const base: ClassCost = { ...DEFAULT_INTERCITY_SETTINGS.classCosts[vehicleClass], ...(settings.classCosts?.[vehicleClass] ?? {}) };
  const own = profile ?? {};
  const fuelType: FuelType = own.fuelType ?? base.fuelType;
  const maxPercent = finite(settings.maxLevelPercent) ? settings.maxLevelPercent : DEFAULT_INTERCITY_SETTINGS.maxLevelPercent;
  const money = (mine: unknown, fallback: number) => (finite(mine) && mine >= 0 ? mine : fallback);
  return {
    fuelType,
    fuelPrice: settings.fuelPrices?.[fuelType] ?? DEFAULT_INTERCITY_SETTINGS.fuelPrices[fuelType],
    kmPerLitre: finite(own.kmPerLitre) && own.kmPerLitre >= 1 ? own.kmPerLitre : Math.max(1, base.kmPerLitre),
    maintenance: money(own.maintenance, base.maintenance),
    labour: money(own.labour, base.labour),
    insurance: money(own.insurance, base.insurance),
    vipCharge: money(own.vipCharge, settings.vipCharge ?? DEFAULT_INTERCITY_SETTINGS.vipCharge),
    saverPercent: clamp(money(own.saverPercent, settings.saverPercent ?? 0), 0, maxPercent),
    premiumPercent: clamp(money(own.premiumPercent, settings.premiumPercent ?? 0), 0, maxPercent),
    custom: Object.values(own).some((v) => v !== undefined && v !== null),
  };
}

export interface CostFareInput extends FareInput {
  passengers: number;
  /** Road km from the driver to the pickup (0 when no driver is chosen yet). */
  pickupKm?: number;
  vip?: boolean;
}

/** Saver / Premium prices are rounded to whole hundreds. */
const roundHundred = (value: number) => Math.round(value / 100) * 100;

/**
 * Pure: the fare from a vehicle's running costs.
 *
 *   Fuel     = (trip km + pickup km) ÷ km per litre × fuel price
 *   Fixed    = maintenance + driver + insurance (once per trip)
 *   Standard = Fuel + Fixed + tolls + surcharge + VIP + app fee × passengers
 *   Saver    = Standard − saver %,  Premium = Standard + premium %   (app fee never discounted)
 *
 * A round trip adds the return fuel and tolls plus the waiting / overnight charge; the
 * fixed costs are charged once. A shared seat is `sharedSeatFraction` of the full-car
 * fare per seat. Every line is rounded to Rs 10 so the breakdown adds up to the total.
 */
export function computeCostFare(input: CostFareInput, settings: CostSettings, costs: ResolvedCosts): FareQuote {
  const route = input.route ?? null;
  const distanceKm = route?.distanceKm || Math.round(input.straightLineKm * settings.roadFactor);
  const durationMinutes =
    route?.durationMinutes || Math.round((distanceKm / Math.max(5, settings.fallbackSpeedKmh)) * 60);
  const pickupKm = Math.max(0, Math.round(input.pickupKm ?? 0));
  const fuelFor = (km: number) => roundFare((km / costs.kmPerLitre) * costs.fuelPrice);
  const fuelNote = `${costs.kmPerLitre} km/l × Rs ${costs.fuelPrice}/l ${costs.fuelType}`;

  const lines: FareLine[] = [{ code: 'fuel', label: `Fuel for ${distanceKm} km (${fuelNote})`, amount: fuelFor(distanceKm) }];
  if (pickupKm > 0) lines.push({ code: 'pickup', label: `Driver to pickup, ${pickupKm} km (fuel)`, amount: fuelFor(pickupKm) });
  if (costs.maintenance > 0) lines.push({ code: 'maintenance', label: 'Car maintenance', amount: roundFare(costs.maintenance) });
  if (costs.labour > 0) lines.push({ code: 'labour', label: 'Driver', amount: roundFare(costs.labour) });
  if (costs.insurance > 0) lines.push({ code: 'insurance', label: 'Insurance', amount: roundFare(costs.insurance) });
  const tolls = route && route.tolls > 0 ? roundFare(route.tolls) : 0;
  if (tolls) lines.push({ code: 'tolls', label: 'Tolls', amount: tolls });
  if (route && route.difficultSurcharge > 0) {
    lines.push({ code: 'difficult_route', label: 'Rough road surcharge', amount: roundFare(route.difficultSurcharge) });
  }
  if (input.vip && costs.vipCharge > 0) lines.push({ code: 'vip', label: 'VIP service', amount: roundFare(costs.vipCharge) });
  const leg = lines.reduce((sum, line) => sum + line.amount, 0);

  let returnLeg = 0;
  if (input.returnWait) {
    const back = fuelFor(distanceKm) + tolls;
    lines.push({ code: 'return_leg', label: `Return journey, ${distanceKm} km (fuel${tolls ? ' and tolls' : ''})`, amount: back });
    returnLeg += back;
    if (input.returnWait.mode === 'hourly') {
      const hours = Math.max(0, Math.ceil(input.returnWait.hours));
      if (hours > 0) {
        const waiting = roundFare(settings.waitingPerHour * hours);
        lines.push({ code: 'waiting', label: `Driver waits ${hours} h`, amount: waiting });
        returnLeg += waiting;
      }
    } else {
      const nights = Math.max(1, Math.ceil(input.returnWait.nights));
      const overnight = roundFare(settings.overnightCharge * nights);
      lines.push({ code: 'overnight', label: `Driver stays ${nights} night${nights === 1 ? '' : 's'}`, amount: overnight });
      returnLeg += overnight;
    }
  }

  const passengers = Math.max(1, Math.floor(input.passengers || input.seats || 1));
  let outbound = leg;
  if (input.rideType === 'shared_seat') {
    const seats = Math.max(1, Math.floor(input.seats ?? passengers));
    const perSeat = roundFare(leg * settings.sharedSeatFraction);
    lines.splice(0, lines.length, { code: 'shared_seats', label: `${seats} × shared seat`, amount: perSeat * seats });
    outbound = perSeat * seats;
    returnLeg = 0;
  }

  const appFee = roundFare(Math.max(0, settings.appFeePerPassenger) * passengers);
  if (appFee > 0) {
    lines.push({ code: 'app_fee', label: `App fee (${passengers} × Rs ${settings.appFeePerPassenger})`, amount: appFee });
    outbound += appFee;
  }

  const subtotal = outbound + returnLeg;
  const driverPart = subtotal - appFee;
  return {
    source: route ? 'route' : 'formula',
    distanceKm,
    durationMinutes,
    lines,
    outbound,
    returnLeg,
    subtotal,
    bidAllowed: input.route ? input.route.bidEnabled : settings.bidOnFallback,
    pricing: 'cost',
    pickupKm,
    appFee,
    levels: {
      saver: Math.max(appFee, roundHundred(driverPart * (1 - costs.saverPercent / 100)) + appFee),
      standard: subtotal,
      premium: roundHundred(driverPart * (1 + costs.premiumPercent / 100)) + appFee,
    },
  };
}

/** Per-seat price of a shared seat (what a shared intercity trip charges per seat). */
export function sharedSeatPrice(quote: FareQuote, seats: number) {
  return Math.round(quote.outbound / Math.max(1, seats));
}

/** Rider cancelling inside the free-cancellation window before departure? Pure. */
export function isLateCancellation(departAt: Date | undefined, freeCancelMinutes: number, now = Date.now()) {
  if (!departAt) return false;
  return new Date(departAt).getTime() - now < freeCancelMinutes * 60_000;
}

/** The settings document, created with defaults the first time. */
export async function getIntercitySettings(): Promise<IIntercitySettings> {
  const found = await IntercitySettings.findOne({ key: 'default' }).lean<IIntercitySettings>();
  // A document saved before a setting existed lacks that field (lean skips defaults).
  if (found) return { ...DEFAULT_INTERCITY_SETTINGS, ...found } as IIntercitySettings;
  try {
    return (await IntercitySettings.create({ key: 'default' })).toObject();
  } catch {
    // Another request created it at the same moment.
    const again = await IntercitySettings.findOne({ key: 'default' }).lean<IIntercitySettings>();
    return again ?? ({ ...DEFAULT_INTERCITY_SETTINGS, key: 'default' } as IIntercitySettings);
  }
}

/** The fixed fare for A → B in this class (or B → A when it applies both ways). */
export async function findRouteFare(fromCityId: string, toCityId: string, vehicleClass: IntercityClass) {
  const direct = await RouteFare.findOne({ fromCityId, toCityId, vehicleClass, active: true }).lean<IRouteFare>();
  if (direct) return direct;
  return RouteFare.findOne({
    fromCityId: toCityId,
    toCityId: fromCityId,
    vehicleClass,
    active: true,
    bothWays: true,
  }).lean<IRouteFare>();
}
