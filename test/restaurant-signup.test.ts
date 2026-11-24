import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { clearDatabase, setupTestDb, teardownTestDb } from './helpers/db';
import { authed, makeUser, type TestUser } from './helpers/auth';

/** The payloads the new web/app restaurant signup sends: map pin, then restaurant + menu. */
describe('Restaurant signup: pin, restaurant profile, menu and offers', () => {
  const app = createApp();
  let owner: TestUser;
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearDatabase();
    owner = await makeUser(app, 'provider', { service: 'restaurant', approved: false });
  });

  it('saves the pin without a transport checkpoint, then the full restaurant profile', async () => {
    const pin = await authed(app, owner.token).put('/api/providers/me').send({
      latitude: 36.3167,
      longitude: 74.65,
      address: 'Karimabad Bazaar, Hunza',
      city: 'Hunza',
      structuredAddress: { city: 'Hunza', formattedAddress: 'Karimabad Bazaar, Hunza', country: 'Pakistan' },
    });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    // Restaurants have no server-side progress: the transport checkpoint is not for them.
    const checkpoint = await authed(app, owner.token).post('/api/providers/me/onboarding/checkpoint').send({ step: 'location' });
    expect(checkpoint.status).toBe(422);

    const saved = await authed(app, owner.token)
      .put('/api/providers/me')
      .send({
        description: 'Family restaurant on the KKH with a terrace view of Rakaposhi.',
        restaurantDetails: {
          restaurantName: 'Rakaposhi View Café',
          description: 'Family restaurant on the KKH with a terrace view of Rakaposhi.',
          cuisineTypes: ['Pakistani', 'Hunza local'],
          menuVariety: ['Chicken karahi', 'Chapshoro'],
          images: ['https://example.com/karahi.jpg'],
          hours: 'Every day · 08:00–23:00',
          offers: [
            { id: 'o1', title: 'Lunch special', type: 'discount', discountPercent: 20, active: true },
            { id: 'o2', title: 'Free tea with any karahi', type: 'offer', active: true },
          ],
          city: 'Hunza',
          address: 'Karimabad Bazaar, Hunza',
          phone: '+920000000000',
          latitude: 36.3167,
          longitude: 74.65,
        },
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const me = await authed(app, owner.token).get('/api/providers/me');
    const r = me.body.data.restaurantDetails;
    expect(r.restaurantName).toBe('Rakaposhi View Café');
    expect(r.cuisineTypes).toEqual(['Pakistani', 'Hunza local']);
    expect(r.menuVariety).toEqual(['Chicken karahi', 'Chapshoro']);
    expect(r.hours).toBe('Every day · 08:00–23:00');
    expect(r.offers.map((o: { title: string }) => o.title)).toEqual(['Lunch special', 'Free tea with any karahi']);
    expect(r.offers[0].discountPercent).toBe(20);
  });
});
