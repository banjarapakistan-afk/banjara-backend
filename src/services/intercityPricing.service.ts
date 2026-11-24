import { IntercitySettings, DEFAULT_INTERCITY_SETTINGS, type ClassCost, type IIntercitySettings } from '../models/IntercitySettings';
import { INTERCITY_CLASSES, type IntercityClass } from '../models/RouteFare';
import { Vehicle, type IVehicleCostProfile } from '../models/Vehicle';
import { AppError, assertFound } from '../utils/AppError';
import { computeCostFare, getIntercitySettings, resolveCosts } from './intercityFare.service';
import { intercityClassOf } from './intercityMatching.service';

/**
 * Cost-based City to City pricing: the admin's fuel prices, app fee and class defaults,
 * and each driver's own running costs per vehicle.
 */

/** The example trip shown next to a driver's costs so they see what their prices come to. */
const EXAMPLE = { km: 100, pickupKm: 10, passengers: 2 };

function pricingSettingsOf(s: IIntercitySettings) {
  const classCosts = Object.fromEntries(
    INTERCITY_CLASSES.map((key) => [key, { ...DEFAULT_INTERCITY_SETTINGS.classCosts[key], ...(s.classCosts?.[key] ?? {}) }])
  ) as Record<IntercityClass, ClassCost>;
  return {
    pricingMode: s.pricingMode ?? 'formula',
    fuelPrices: { ...DEFAULT_INTERCITY_SETTINGS.fuelPrices, ...(s.fuelPrices ?? {}) },
    appFeePerPassenger: s.appFeePerPassenger,
    vipCharge: s.vipCharge,
    saverPercent: s.saverPercent,
    premiumPercent: s.premiumPercent,
    maxLevelPercent: s.maxLevelPercent,
    classCosts,
  };
}

/* Admin --------------------------------------------------------------- */

export async function getPricingSettings() {
  return pricingSettingsOf(await getIntercitySettings());
}

export type PricingSettingsInput = Partial<{
  pricingMode: 'formula' | 'cost';
  fuelPrices: Partial<IIntercitySettings['fuelPrices']>;
  appFeePerPassenger: number;
  vipCharge: number;
  saverPercent: number;
  premiumPercent: number;
  maxLevelPercent: number;
  classCosts: Partial<Record<IntercityClass, Partial<ClassCost>>>;
}>;

export async function updatePricingSettings(input: PricingSettingsInput) {
  const current = pricingSettingsOf(await getIntercitySettings());
  const maxLevelPercent = input.maxLevelPercent ?? current.maxLevelPercent;
  const saverPercent = input.saverPercent ?? current.saverPercent;
  const premiumPercent = input.premiumPercent ?? current.premiumPercent;
  if (saverPercent > maxLevelPercent || premiumPercent > maxLevelPercent) {
    throw new AppError(`Saver and Premium can't be more than the ${maxLevelPercent}% drivers are allowed.`, 422);
  }
  const classCosts = { ...current.classCosts };
  for (const key of INTERCITY_CLASSES) {
    if (input.classCosts?.[key]) classCosts[key] = { ...classCosts[key], ...input.classCosts[key] };
  }
  await IntercitySettings.updateOne(
    { key: 'default' },
    {
      $set: {
        pricingMode: input.pricingMode ?? current.pricingMode,
        fuelPrices: { ...current.fuelPrices, ...(input.fuelPrices ?? {}) },
        appFeePerPassenger: input.appFeePerPassenger ?? current.appFeePerPassenger,
        vipCharge: input.vipCharge ?? current.vipCharge,
        saverPercent,
        premiumPercent,
        maxLevelPercent,
        classCosts,
      },
    },
    { upsert: true, runValidators: true }
  );
  return getPricingSettings();
}

/* Driver -------------------------------------------------------------- */

type PricedVehicle = { _id: unknown; name: string; type: string; seatCount: number; status: string; costProfile?: IVehicleCostProfile };

function vehiclePricing(v: PricedVehicle, s: IIntercitySettings) {
  const vehicleClass = intercityClassOf(v.type);
  if (!vehicleClass) return null;
  const effective = resolveCosts(s, vehicleClass, v.costProfile);
  const defaults = resolveCosts(s, vehicleClass, null);
  const example = computeCostFare(
    {
      vehicleClass,
      rideType: 'full_car',
      straightLineKm: EXAMPLE.km / Math.max(1, s.roadFactor),
      route: null,
      returnWait: null,
      passengers: EXAMPLE.passengers,
      pickupKm: EXAMPLE.pickupKm,
    },
    { ...s, roadFactor: Math.max(1, s.roadFactor) },
    effective
  );
  const { custom, ...costs } = effective;
  const { custom: _unused, ...defaultCosts } = defaults;
  return {
    id: String(v._id),
    name: v.name,
    type: v.type,
    class: vehicleClass,
    seats: v.seatCount,
    status: v.status,
    custom,
    own: v.costProfile ?? {},
    defaults: defaultCosts,
    effective: costs,
    example: { ...EXAMPLE, distanceKm: example.distanceKm, levels: example.levels, lines: example.lines },
  };
}

export async function getDriverPricing(providerId: string) {
  const s = await getIntercitySettings();
  const vehicles = await Vehicle.find({ providerId, status: { $in: ['active', 'pending'] } })
    .select('name type seatCount status costProfile')
    .sort({ createdAt: 1 })
    .lean<PricedVehicle[]>();
  const settings = pricingSettingsOf(s);
  return {
    pricingMode: settings.pricingMode,
    fuelPrices: settings.fuelPrices,
    appFeePerPassenger: settings.appFeePerPassenger,
    maxLevelPercent: settings.maxLevelPercent,
    vehicles: vehicles.map((v) => vehiclePricing(v, s)).filter(Boolean),
  };
}

/** Null clears a field back to BANJARA's default. */
export type VehicleCostInput = { [K in keyof IVehicleCostProfile]?: IVehicleCostProfile[K] | null };

export async function updateVehiclePricing(providerId: string, vehicleId: string, input: VehicleCostInput) {
  const s = await getIntercitySettings();
  const vehicle = assertFound(
    await Vehicle.findOne({ _id: vehicleId, providerId }).select('name type seatCount status costProfile'),
    'Vehicle not found'
  );
  if (!intercityClassOf(vehicle.type)) throw new AppError('This vehicle type is not used for City to City rides.', 422);
  const max = s.maxLevelPercent ?? DEFAULT_INTERCITY_SETTINGS.maxLevelPercent;
  for (const key of ['saverPercent', 'premiumPercent'] as const) {
    const value = input[key];
    if (value != null && value > max) throw new AppError(`Saver and Premium can be at most ${max}%.`, 422);
  }
  const next: IVehicleCostProfile = { ...((vehicle.toObject().costProfile as IVehicleCostProfile | undefined) ?? {}) };
  for (const [key, value] of Object.entries(input) as Array<[keyof IVehicleCostProfile, unknown]>) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  vehicle.set('costProfile', Object.keys(next).length ? next : undefined);
  await vehicle.save();
  const updated = vehiclePricing(vehicle.toObject() as PricedVehicle, s);
  if (!updated) throw new AppError('Vehicle not found', 404);
  return updated;
}
