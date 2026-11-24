import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { User } from '../src/models/User';
import { authHeader, makeUser } from './helpers/auth';
import { clearDatabase, setupTestDb, teardownTestDb } from './helpers/db';

const PASSWORD = 'Password123';

/** Traveller and provider accounts are separate, and each portal signs in only its own kind. */
describe('Account roles', () => {
  const app = createApp();

  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await clearDatabase();
  });

  const login = (email: string, scope?: 'site' | 'admin') => {
    const req = request(app).post('/api/auth/login');
    if (scope) req.set('X-Session-Scope', scope);
    return req.send({ email, password: PASSWORD });
  };

  it('a traveller account cannot apply as a provider, and stays a traveller', async () => {
    const customer = await makeUser(app, 'customer');
    const res = await request(app)
      .post('/api/providers/register')
      .set(authHeader(customer.token))
      .send({
        businessName: 'Sneaky Travels',
        ownerName: 'Test',
        providerType: ['busOperator'],
        services: ['transport'],
        phone: '+920000000000',
        email: customer.email,
        address: 'Test Address 1',
        city: 'Islamabad',
        latitude: 33.6844,
        longitude: 73.0479,
      });
    expect(res.status).toBe(403);
    expect((await User.findById(customer.id))?.role).toBe('customer');
  });

  it('a provider cannot book as a traveller', async () => {
    const provider = await makeUser(app, 'provider');
    const res = await request(app).get('/api/bookings/my-bookings').set(authHeader(provider.token));
    expect(res.status).toBe(403);
  });

  it('the website refuses admin accounts', async () => {
    const admin = await makeUser(app, 'admin');
    const res = await login(admin.email, 'site');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin portal/i);
  });

  it('the admin portal refuses traveller and provider accounts', async () => {
    const customer = await makeUser(app, 'customer');
    const provider = await makeUser(app, 'provider');
    expect((await login(customer.email, 'admin')).status).toBe(403);
    expect((await login(provider.email, 'admin')).status).toBe(403);
  });

  it('the website signs in travellers and providers with their own role', async () => {
    const customer = await makeUser(app, 'customer');
    const provider = await makeUser(app, 'provider');
    const c = await login(customer.email, 'site');
    const p = await login(provider.email, 'site');
    expect(c.status).toBe(200);
    expect(c.body.data.user.role).toBe('customer');
    expect(p.status).toBe(200);
    expect(p.body.data.user.role).toBe('provider');
  });
});
