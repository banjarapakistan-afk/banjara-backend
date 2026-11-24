import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { ProviderProfile } from '../src/models/ProviderProfile';
import { clearProviderCountsCache } from '../src/services/providerCounts.service';
import { clearDatabase, setupTestDb, teardownTestDb } from './helpers/db';
import { makeUser } from './helpers/auth';

describe('GET /api/providers/public/counts', () => {
  const app = createApp();
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearDatabase();
    clearProviderCountsCache();
  });

  it('counts real providers per service, approved vs registered, without login or private data', async () => {
    await makeUser(app, 'provider', { service: 'transport' }); // approved
    await makeUser(app, 'provider', { service: 'transport', approved: false }); // pending
    await makeUser(app, 'provider', { service: 'hotel' });
    const rejected = await makeUser(app, 'provider', { service: 'hotel' });
    await ProviderProfile.findByIdAndUpdate(rejected.providerId, { verificationStatus: 'rejected' });
    // An older profile saved under an alias still counts for its service.
    const legacy = await makeUser(app, 'provider', { service: 'transport', approved: false });
    await ProviderProfile.updateOne({ _id: legacy.providerId }, { $set: { services: ['carRental'] } });
    clearProviderCountsCache();

    const res = await request(app).get('/api/providers/public/counts');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = res.body.data;
    expect(data.services.transport).toEqual({ approved: 1, registered: 3 });
    expect(data.services.hotel).toEqual({ approved: 1, registered: 1 });
    expect(data.services.travelGuide).toEqual({ approved: 0, registered: 0 });
    expect(data.total).toEqual({ approved: 2, registered: 4 });
    // Numbers only: no names, emails or ids leak from this public endpoint.
    expect(JSON.stringify(data)).not.toMatch(/@|Travels|_id/);
  });

  it('is not mistaken for a provider id', async () => {
    const res = await request(app).get('/api/providers/public/counts');
    expect(res.status).toBe(200);
    expect(res.body.data.services).toHaveProperty('restaurant');
  });
});
