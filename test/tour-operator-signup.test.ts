import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { clearDatabase, setupTestDb, teardownTestDb } from './helpers/db';
import { authed, makeUser, type TestUser } from './helpers/auth';

/** The payloads the new web/app tour-operator signup sends: company profile, first tour, submit. */
describe('Tour operator signup: company profile and first tour', () => {
  const app = createApp();
  let operator: TestUser;
  beforeAll(setupTestDb);
  afterAll(teardownTestDb);
  beforeEach(async () => {
    await clearDatabase();
    operator = await makeUser(app, 'provider', { service: 'tour', approved: false });
  });

  it('saves the company, creates a draft tour with a day plan, then submits it for review', async () => {
    const company = await authed(app, operator.token)
      .put('/api/providers/me')
      .send({
        logo: '',
        yearsExperience: 12,
        description: 'Family-run operator from Skardu running small-group treks since 2012.',
        tourDetails: {
          companyName: 'Skardu Trails',
          description: 'Family-run operator from Skardu running small-group treks since 2012.',
          yearsExperience: 12,
          operatingAreas: ['Skardu', 'Deosai'],
          specialties: ['Treks', 'Jeep safaris'],
          internationalLanguages: ['Urdu', 'English', 'Balti'],
          regionalLanguages: [],
          certifications: ['Tourism licence: GB-DTS-1234'],
          images: [],
        },
      });
    expect(company.status, JSON.stringify(company.body)).toBe(200);

    const created = await authed(app, operator.token)
      .post('/api/tour-itineraries')
      .send({
        title: 'Deosai Trek — 3 Days',
        tourType: 'trek',
        summary: 'Camp on the Deosai plains and spot brown bears.',
        // Built from the summary + plan when the operator leaves the description empty (20+ chars).
        description: 'Camp on the Deosai plains and spot brown bears.\n\nDay 1: Skardu to Bara Pani\nDay 2: Sheosar Lake\nDay 3: Back to Skardu',
        destination: 'Deosai',
        durationDays: 3,
        durationNights: 2,
        difficulty: 'moderate',
        maxParticipants: 10,
        pricePerPerson: 45000,
        currency: 'PKR',
        included: ['Transport', 'Camping gear'],
        excluded: ['Flights'],
        days: [
          { dayNumber: 1, title: 'Skardu to Bara Pani', description: '' },
          { dayNumber: 2, title: 'Sheosar Lake', description: '' },
          { dayNumber: 3, title: 'Back to Skardu', description: '' },
        ],
        coverImage: 'https://example.com/deosai.jpg',
        images: ['https://example.com/deosai.jpg'],
        departureLocation: 'Skardu',
        bestSeason: 'Summer, Autumn',
        submitForReview: false,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tour = created.body.data;
    expect(tour.status).toBe('draft');
    expect(tour.days).toHaveLength(3);

    const mine = await authed(app, operator.token).get('/api/tour-itineraries/mine');
    expect(mine.status).toBe(200);
    const items = Array.isArray(mine.body.data) ? mine.body.data : mine.body.data.items;
    expect(items).toHaveLength(1);

    const submitted = await authed(app, operator.token)
      .put(`/api/tour-itineraries/${tour.id ?? tour._id}`)
      .send({ submitForReview: true });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe('pending');

    const me = await authed(app, operator.token).get('/api/providers/me');
    expect(me.body.data.tourDetails.operatingAreas).toEqual(['Skardu', 'Deosai']);
    expect(me.body.data.tourDetails.certifications).toContain('Tourism licence: GB-DTS-1234');
  });
});
