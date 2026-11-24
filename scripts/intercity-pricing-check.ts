/**
 * Local check of City to City cost pricing.
 *
 *   npx tsx scripts/intercity-pricing-check.ts            list drivers, vehicles and their prices (read-only)
 *   npx tsx scripts/intercity-pricing-check.ts --apply    also give each vehicle sample running costs
 *
 * For every transport driver's vehicle it prints the costs used and the Saver / Standard /
 * Premium prices for a sample Islamabad → Gilgit (600 km) ride with 2 passengers, with the
 * fuel worked out by hand next to it so the calculation can be checked.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { ProviderProfile } from '../src/models/ProviderProfile';
import { Vehicle, type IVehicleCostProfile } from '../src/models/Vehicle';
import { computeCostFare, getIntercitySettings, haversineKm, resolveCosts } from '../src/services/intercityFare.service';
import { getCity } from '../src/services/city.service';
import { intercityClassOf } from '../src/services/intercityMatching.service';

const APPLY = process.argv.includes('--apply');
const PICKUP = { lat: 33.7215, lng: 73.0433, name: 'F-7 Markaz, Islamabad' };
const TRIP_KM = 600;
const PASSENGERS = 2;

/** Sample running costs per class, a little different from the defaults so the change shows. */
const SAMPLE: Record<string, IVehicleCostProfile> = {
  car: { fuelType: 'petrol', kmPerLitre: 14, maintenance: 1000, labour: 1500, insurance: 1000, vipCharge: 2000, saverPercent: 10, premiumPercent: 15 },
  suv: { fuelType: 'petrol', kmPerLitre: 10, maintenance: 1200, labour: 1800, insurance: 1200, vipCharge: 2500, saverPercent: 8, premiumPercent: 20 },
  jeep: { fuelType: 'diesel', kmPerLitre: 8, maintenance: 1500, labour: 1800, insurance: 1200, vipCharge: 2500, saverPercent: 10, premiumPercent: 15 },
  van: { fuelType: 'diesel', kmPerLitre: 9, maintenance: 1500, labour: 2000, insurance: 1200, vipCharge: 3000, saverPercent: 10, premiumPercent: 15 },
  coaster: { fuelType: 'diesel', kmPerLitre: 5, maintenance: 2500, labour: 2500, insurance: 2000, vipCharge: 4000, saverPercent: 5, premiumPercent: 10 },
};

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`;

async function main() {
  await connectDatabase();
  const settings = await getIntercitySettings();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(
    `Pricing mode: ${settings.pricingMode} | petrol ${rs(settings.fuelPrices.petrol)}/l, diesel ${rs(settings.fuelPrices.diesel)}/l | app fee ${rs(settings.appFeePerPassenger)}/passenger\n`
  );

  const providers = await ProviderProfile.find({ services: 'transport' })
    .select('businessName ownerName verificationStatus intercity location')
    .lean();
  if (!providers.length) console.log('No transport providers found.');

  for (const p of providers) {
    const ic = (p as { intercity?: { enabled?: boolean; homeCityId?: unknown } }).intercity ?? {};
    const coords = p.location?.coordinates;
    let start: { lat: number; lng: number } | null =
      coords?.length === 2 && (coords[0] !== 0 || coords[1] !== 0) ? { lat: coords[1], lng: coords[0] } : null;
    let startNote = start ? 'pinned location' : 'none';
    if (!start && ic.homeCityId) {
      const city = await getCity(String(ic.homeCityId));
      const c = city?.location?.coordinates;
      if (c?.length === 2) {
        start = { lat: c[1], lng: c[0] };
        startNote = `home city ${city?.name}`;
      }
    }
    const pickupKm = start ? Math.round(haversineKm(start, PICKUP) * settings.roadFactor) : 0;
    console.log('='.repeat(78));
    console.log(`${p.businessName || p.ownerName || 'Driver'} (${p._id})`);
    console.log(
      `  status: ${p.verificationStatus} | City to City: ${ic.enabled ? 'on' : 'OFF'} | starts from: ${startNote} | to pickup (${PICKUP.name}): ${pickupKm} km`
    );

    const vehicles = await Vehicle.find({ providerId: p._id }).select('name type seatCount status costProfile');
    if (!vehicles.length) console.log('  (no vehicles)');
    for (const v of vehicles) {
      const vehicleClass = intercityClassOf(v.type);
      if (!vehicleClass) {
        console.log(`  - ${v.name} [${v.type}, ${v.status}]: not a City to City vehicle type`);
        continue;
      }
      if (APPLY) {
        v.set('costProfile', { ...SAMPLE[vehicleClass] });
        await v.save();
      }
      const own = (v.toObject().costProfile ?? null) as IVehicleCostProfile | null;
      const costs = resolveCosts(settings, vehicleClass, own);
      const quote = computeCostFare(
        {
          vehicleClass,
          rideType: 'full_car',
          straightLineKm: 0,
          route: { distanceKm: TRIP_KM, durationMinutes: 960, tolls: 0, difficultSurcharge: 0, bidEnabled: false },
          returnWait: null,
          passengers: PASSENGERS,
          pickupKm,
        },
        settings,
        costs
      );
      console.log(`  - ${v.name} [${vehicleClass}, ${v.seatCount} seats, ${v.status}] ${costs.custom ? '(own costs)' : '(BANJARA defaults)'}`);
      console.log(
        `      costs: ${costs.fuelType} ${costs.kmPerLitre} km/l @ ${rs(costs.fuelPrice)}/l | maintenance ${rs(costs.maintenance)} | driver ${rs(costs.labour)} | insurance ${rs(costs.insurance)} | saver -${costs.saverPercent}% premium +${costs.premiumPercent}%`
      );
      console.log(
        `      by hand: fuel ${TRIP_KM} ÷ ${costs.kmPerLitre} × ${costs.fuelPrice} = ${rs((TRIP_KM / costs.kmPerLitre) * costs.fuelPrice)}; pickup ${pickupKm} ÷ ${costs.kmPerLitre} × ${costs.fuelPrice} = ${rs((pickupKm / costs.kmPerLitre) * costs.fuelPrice)}`
      );
      for (const line of quote.lines) console.log(`      ${line.label.padEnd(56)} ${rs(line.amount).padStart(10)}`);
      console.log(
        `      => Saver ${rs(quote.levels!.saver)} | Standard ${rs(quote.levels!.standard)} | Premium ${rs(quote.levels!.premium)}`
      );
    }
  }
  console.log('='.repeat(78));
  console.log(APPLY ? 'Sample costs saved on every City to City vehicle.' : 'Read-only. Run with --apply to save sample costs on the vehicles.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
