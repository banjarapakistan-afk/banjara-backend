import { ProviderProfile } from '../models/ProviderProfile';

/** The five services a provider can choose, as shown on the "What service do you provide?" screen. */
export const PROVIDER_SERVICE_KEYS = ['transport', 'hotel', 'tour', 'travelGuide', 'restaurant'] as const;
export type ProviderServiceKey = (typeof PROVIDER_SERVICE_KEYS)[number];

/** Older profiles stored other names for the same service. */
const ALIASES: Record<string, ProviderServiceKey> = {
  transport: 'transport',
  carRental: 'transport',
  hotel: 'hotel',
  guestHouse: 'hotel',
  lodge: 'hotel',
  hostel: 'hotel',
  tour: 'tour',
  travelAgency: 'tour',
  travelGuide: 'travelGuide',
  guide: 'travelGuide',
  tourGuide: 'travelGuide',
  restaurant: 'restaurant',
};

export type ServiceCount = {
  /** Approved and live: travellers can book them now. */
  approved: number;
  /** Everyone who signed up for this service and isn't rejected or suspended (includes pending). */
  registered: number;
};

export type ProviderCounts = {
  services: Record<ProviderServiceKey, ServiceCount>;
  total: ServiceCount;
  updatedAt: string;
};

/**
 * Counts real provider accounts per service. Public (shown on the signup screen), so it returns
 * numbers only, never names or contact details. Cached briefly: the numbers change slowly and
 * the screen is public.
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; value: Promise<ProviderCounts> } | null = null;

export function clearProviderCountsCache() {
  cache = null;
}

export async function getProviderCounts(): Promise<ProviderCounts> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = countProviders();
  cache = { at: Date.now(), value };
  try {
    return await value;
  } catch (error) {
    cache = null;
    throw error;
  }
}

async function countProviders(): Promise<ProviderCounts> {
  const rows = await ProviderProfile.aggregate<{ _id: { service: string; status: string }; count: number }>([
    { $match: { verificationStatus: { $in: ['approved', 'pending'] } } },
    { $unwind: '$services' },
    { $group: { _id: { service: '$services', status: '$verificationStatus' }, count: { $sum: 1 } } },
  ]);

  const services = Object.fromEntries(
    PROVIDER_SERVICE_KEYS.map((key) => [key, { approved: 0, registered: 0 }]),
  ) as Record<ProviderServiceKey, ServiceCount>;
  for (const row of rows) {
    const key = ALIASES[row._id.service];
    if (!key) continue;
    services[key].registered += row.count;
    if (row._id.status === 'approved') services[key].approved += row.count;
  }
  const total = PROVIDER_SERVICE_KEYS.reduce(
    (sum, key) => ({ approved: sum.approved + services[key].approved, registered: sum.registered + services[key].registered }),
    { approved: 0, registered: 0 },
  );
  return { services, total, updatedAt: new Date().toISOString() };
}
