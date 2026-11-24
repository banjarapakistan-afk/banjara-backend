import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERCITY_SETTINGS } from '../src/models/IntercitySettings';
import { computeCostFare, resolveCosts } from '../src/services/intercityFare.service';

const settings = { ...DEFAULT_INTERCITY_SETTINGS };
const sum = (lines: { amount: number }[]) => lines.reduce((total, line) => total + line.amount, 0);
const route600 = { distanceKm: 600, durationMinutes: 960, tolls: 0, difficultSurcharge: 0, bidEnabled: false };

describe('Cost-based City to City fares (pure)', () => {
  it("prices the client's 600 km example from the car's running costs", () => {
    const costs = resolveCosts(settings, 'car');
    expect(costs).toMatchObject({ fuelType: 'petrol', fuelPrice: 365, kmPerLitre: 12, maintenance: 1000, labour: 1500, insurance: 1000 });
    const quote = computeCostFare(
      { vehicleClass: 'car', rideType: 'full_car', straightLineKm: 450, route: route600, passengers: 2, pickupKm: 10 },
      settings,
      costs
    );
    // Fuel 600 ÷ 12 × 365 = 18,250; pickup 10 km ≈ 300; fixed 3,500; app fee 2 × 100.
    expect(quote.lines.map((l) => [l.code, l.amount])).toEqual([
      ['fuel', 18250],
      ['pickup', 300],
      ['maintenance', 1000],
      ['labour', 1500],
      ['insurance', 1000],
      ['app_fee', 200],
    ]);
    expect(quote.subtotal).toBe(22250);
    expect(sum(quote.lines)).toBe(quote.subtotal);
    expect(quote.pricing).toBe('cost');
    expect(quote.appFee).toBe(200);
    // Saver −10% and Premium +15% on the driver's part, rounded to Rs 100; the app fee is never discounted.
    expect(quote.levels).toEqual({ saver: 20000, standard: 22250, premium: 25600 });
  });

  it("uses the driver's own costs where set and the class defaults for the rest", () => {
    const costs = resolveCosts(settings, 'car', { kmPerLitre: 15, labour: 2000, saverPercent: 5, premiumPercent: 99 });
    expect(costs.kmPerLitre).toBe(15);
    expect(costs.labour).toBe(2000);
    expect(costs.maintenance).toBe(1000);
    expect(costs.saverPercent).toBe(5);
    // Capped at the admin's maximum.
    expect(costs.premiumPercent).toBe(settings.maxLevelPercent);
    expect(costs.custom).toBe(true);
    expect(resolveCosts(settings, 'car').custom).toBe(false);
  });

  it('follows the fuel price for the vehicle\'s fuel type', () => {
    const coaster = resolveCosts({ ...settings, fuelPrices: { petrol: 365, diesel: 400 } }, 'coaster');
    expect(coaster.fuelType).toBe('diesel');
    expect(coaster.fuelPrice).toBe(400);
  });

  it('adds VIP, tolls, and a round trip with return fuel and waiting (fixed costs once)', () => {
    const costs = resolveCosts(settings, 'car');
    const quote = computeCostFare(
      {
        vehicleClass: 'car',
        rideType: 'full_car',
        straightLineKm: 0,
        route: { ...route600, distanceKm: 120, tolls: 300 },
        passengers: 1,
        vip: true,
        returnWait: { mode: 'hourly', hours: 3 },
      },
      settings,
      costs
    );
    const codes = quote.lines.map((l) => l.code);
    expect(codes).toEqual(['fuel', 'maintenance', 'labour', 'insurance', 'tolls', 'vip', 'return_leg', 'waiting', 'app_fee']);
    // Return leg: 120 km fuel (3,650) + tolls (300).
    expect(quote.lines.find((l) => l.code === 'return_leg')?.amount).toBe(3650 + 300);
    expect(quote.lines.find((l) => l.code === 'waiting')?.amount).toBe(1500);
    expect(quote.returnLeg).toBe(3950 + 1500);
    expect(sum(quote.lines)).toBe(quote.subtotal);
  });

  it('charges a shared seat a fraction of the car per seat, plus the app fee per passenger', () => {
    const costs = resolveCosts(settings, 'car');
    const full = computeCostFare({ vehicleClass: 'car', rideType: 'full_car', straightLineKm: 0, route: route600, passengers: 1 }, settings, costs);
    const shared = computeCostFare({ vehicleClass: 'car', rideType: 'shared_seat', seats: 2, straightLineKm: 0, route: route600, passengers: 2 }, settings, costs);
    const fullLeg = full.subtotal - 100;
    const perSeat = Math.round((fullLeg * settings.sharedSeatFraction) / 10) * 10;
    expect(shared.lines.map((l) => l.code)).toEqual(['shared_seats', 'app_fee']);
    expect(shared.subtotal).toBe(perSeat * 2 + 200);
  });

  it('estimates road km from straight-line distance when the route is unknown', () => {
    const quote = computeCostFare(
      { vehicleClass: 'car', rideType: 'full_car', straightLineKm: 100, route: null, passengers: 1 },
      settings,
      resolveCosts(settings, 'car')
    );
    expect(quote.distanceKm).toBe(130);
    expect(quote.pickupKm).toBe(0);
    expect(quote.lines.some((l) => l.code === 'pickup')).toBe(false);
  });
});
