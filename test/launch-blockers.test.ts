import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app';
import { Booking } from '../src/models/Booking';
import { Payment } from '../src/models/Payment';
import { ProviderProfile } from '../src/models/ProviderProfile';
import { Trip } from '../src/models/Trip';
import { Vehicle } from '../src/models/Vehicle';
import * as resetDelivery from '../src/services/notification/passwordResetDelivery';
import { expireStalePayments } from '../src/services/payment.service';
import { assessImageQuality } from '../src/utils/cnic/imageQuality';
import { clearDatabase, ensureIndexes, setupTestDb, teardownTestDb } from './helpers/db';
import { authed, makeUser, type TestUser } from './helpers/auth';

/**
 * Regression tests for the problems found in the pre-launch review. Each one failed
 * against the code as it stood before the fix.
 */
describe('Pre-launch review fixes', () => {
  const app = createApp();

  beforeAll(async () => {
    await setupTestDb();
    await ensureIndexes();
  });
  afterAll(teardownTestDb);
  beforeEach(clearDatabase);

  describe('public provider payloads', () => {
    const PRIVATE = {
      driverCnic: '35202-1234567-1',
      driverLicenseNumber: 'LICENCE-PRIVATE-1',
      driverPermanentAddress: 'HOME-ADDRESS-PRIVATE-1',
      driverEmergencyContact: 'EMERGENCY-PRIVATE-1',
      driverPhone: 'DRIVER-PHONE-PRIVATE-1',
      engineNumber: 'ENGINE-PRIVATE-1',
      insuranceNumber: 'INSURANCE-PRIVATE-1',
    };

    it('never include identity documents, the commission rate or review notes', async () => {
      const provider = await makeUser(app, 'provider', { service: 'transport' });
      await ProviderProfile.findByIdAndUpdate(provider.providerId, {
        transportDetails: { driverName: 'Public Driver', ...PRIVATE },
        platformFeePercent: 12,
        rejectionReason: 'REVIEW-NOTE-PRIVATE-1',
        identityVerification: {
          verificationStatus: 'verified',
          cnicVerified: true,
          cnicNumberMasked: 'MASKED-CNIC-PRIVATE-1',
        },
      });

      const catalog = await request(app).get('/api/providers/catalog').query({ service: 'transport' });
      expect(catalog.status).toBe(200);
      const row = (catalog.body.data as Array<{ _id: string }>).find((r) => r._id === provider.providerId);
      expect(row, 'provider is listed in the catalog').toBeTruthy();

      const single = await request(app).get(`/api/providers/public/${provider.providerId}`);
      expect(single.status).toBe(200);

      for (const payload of [row, single.body.data] as Array<Record<string, any>>) {
        const text = JSON.stringify(payload);
        for (const secret of [...Object.values(PRIVATE), 'REVIEW-NOTE-PRIVATE-1', 'MASKED-CNIC-PRIVATE-1']) {
          expect(text).not.toContain(secret);
        }
        for (const field of ['platformFeePercent', 'identityVerification', 'rejectionReason', 'onboarding']) {
          expect(payload).not.toHaveProperty(field);
        }
        // What a traveller is meant to see is still there.
        expect(payload.businessName).toBeTruthy();
        expect(payload.transportDetails.driverName).toBe('Public Driver');
      }
    });

    it('treat the catalog city filter as literal text, not a pattern', async () => {
      const res = await request(app).get('/api/providers/catalog').query({ city: '(' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('guide review fields', () => {
    const licence = {
      id: 'doc-1',
      type: 'guide_license',
      fileUrl: 'https://example.com/licence.jpg',
      status: 'verified',
    };

    async function makeGuide() {
      const guide = await makeUser(app, 'provider', { service: 'transport', approved: false });
      await ProviderProfile.findByIdAndUpdate(guide.providerId, {
        services: ['travelGuide'],
        providerType: ['travelGuide'],
      });
      return guide;
    }
    async function storedGuide(guide: TestUser) {
      const profile = await ProviderProfile.findById(guide.providerId).lean();
      return profile!.guideDetails as Record<string, any>;
    }

    it('cannot be set by the guide through either profile route', async () => {
      const guide = await makeGuide();

      const viaGuideRoute = await authed(app, guide.token).put('/api/guides/me/profile').send({
        fullName: 'Test Guide',
        profileStatus: 'approved',
        changesRequestedNote: 'written by the guide',
        documents: [licence],
      });
      expect(viaGuideRoute.status).toBe(200);
      let stored = await storedGuide(guide);
      expect(stored.fullName).toBe('Test Guide');
      expect(stored.profileStatus).toBe('draft');
      expect(stored.changesRequestedNote).toBeUndefined();
      expect(stored.documents[0].status).toBe('pending');

      const viaProviderRoute = await authed(app, guide.token)
        .put('/api/providers/me')
        .send({ guideDetails: { fullName: 'Test Guide', profileStatus: 'approved', documents: [licence] } });
      expect(viaProviderRoute.status).toBe(200);
      stored = await storedGuide(guide);
      expect(stored.profileStatus).toBe('draft');
      expect(stored.documents[0].status).toBe('pending');
    });

    it('keep the admin decision when the guide edits, and reset a replaced document', async () => {
      const guide = await makeGuide();
      await ProviderProfile.findByIdAndUpdate(guide.providerId, {
        guideDetails: { fullName: 'Test Guide', profileStatus: 'approved', documents: [licence] },
      });

      const edit = await authed(app, guide.token).put('/api/guides/me/profile').send({
        shortBio: 'Updated bio',
        profileStatus: 'rejected',
        documents: [{ ...licence, status: 'rejected' }],
      });
      expect(edit.status).toBe(200);
      let stored = await storedGuide(guide);
      expect(stored.shortBio).toBe('Updated bio');
      expect(stored.profileStatus).toBe('approved');
      expect(stored.documents[0].status).toBe('verified');

      const replaced = await authed(app, guide.token).put('/api/guides/me/profile').send({
        documents: [{ ...licence, fileUrl: 'https://example.com/another-file.jpg' }],
      });
      expect(replaced.status).toBe(200);
      stored = await storedGuide(guide);
      expect(stored.documents[0].status).toBe('pending');
    });
  });

  describe('hotel date ranges', () => {
    it('are refused when absurdly long instead of being walked night by night', async () => {
      const hotelId = new mongoose.Types.ObjectId().toString();

      const huge = await request(app)
        .get(`/api/rooms/hotel/${hotelId}`)
        .query({ checkIn: '2000-01-01', checkOut: '9999-12-31' });
      expect(huge.status).toBe(400);
      expect(huge.body.message).toMatch(/Date range too large/);

      const normal = await request(app)
        .get(`/api/rooms/hotel/${hotelId}`)
        .query({ checkIn: '2030-01-01', checkOut: '2030-01-05' });
      expect(normal.status).toBe(200);
    });
  });

  describe('identity card images', () => {
    /** A PNG header declaring the given canvas, padded with varied bytes. */
    function pngDeclaring(width: number, height: number, bytes = 20_000) {
      const buf = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i += 1) buf[i] = (i * 31 + 7) % 251;
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
      buf.writeUInt32BE(13, 8);
      buf.write('IHDR', 12, 'ascii');
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    }

    it('are refused when the declared canvas is huge, whatever the file size', () => {
      expect(assessImageQuality(pngDeclaring(16000, 16000)).ok).toBe(false);
      expect(assessImageQuality(pngDeclaring(16000, 10000)).ok).toBe(false);
      expect(assessImageQuality(pngDeclaring(9000, 3000)).ok).toBe(false);
      // An ordinary phone photo of a card still passes.
      expect(assessImageQuality(pngDeclaring(4000, 3000)).ok).toBe(true);
    });
  });

  describe('forgot password', () => {
    it('answers a registered email exactly like an unknown one when delivery fails', async () => {
      const known = await makeUser(app, 'customer');
      const delivery = vi
        .spyOn(resetDelivery, 'deliverPasswordResetToken')
        .mockRejectedValue(new Error('No password reset delivery provider configured'));
      try {
        const knownRes = await request(app).post('/api/auth/forgot-password').send({ email: known.email });
        const unknownRes = await request(app)
          .post('/api/auth/forgot-password')
          .send({ email: `nobody_${Date.now()}@example.com` });

        // The failure really happened on the registered-email branch.
        expect(delivery).toHaveBeenCalledTimes(1);
        expect(knownRes.status).toBe(200);
        expect(unknownRes.status).toBe(200);
        expect(knownRes.body).toEqual(unknownRes.body);
      } finally {
        delivery.mockRestore();
      }
    });
  });

  describe('cash booking holds', () => {
    async function cashBooking() {
      const customer = await makeUser(app, 'customer');
      const provider = await makeUser(app, 'provider', { service: 'transport' });
      const vehicle = await Vehicle.create({
        providerId: provider.providerId,
        name: `Bus ${Date.now()}`,
        type: 'bus',
        brand: 'Hino',
        vehicleModel: 'AK',
        year: 2021,
        registrationNumber: `REG-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        seatCount: 20,
        status: 'active',
      });
      const trip = await authed(app, provider.token).post('/api/trips').send({
        vehicleId: vehicle._id.toString(),
        origin: 'Gilgit',
        destination: 'Hunza',
        departureDate: '2030-01-01',
        departureTime: '09:00',
        price: 3500,
      });
      expect(trip.status).toBe(201);
      const tripId = trip.body.data._id as string;
      const booking = await authed(app, customer.token)
        .post('/api/bookings')
        .send({
          bookingType: 'transport',
          paymentMethod: 'cash',
          transportBooking: {
            tripId,
            seats: ['A1'],
            passengerDetails: [{ name: 'Traveller One', phone: '03001234567' }],
          },
        });
      expect(booking.status).toBe(201);
      return { customer, provider, tripId, bookingId: booking.body.data._id as string };
    }
    const seatStatus = async (tripId: string) =>
      (await Trip.findById(tripId))!.seatLayout.find((seat) => seat.seatNumber === 'A1')!.status;
    const past = () => new Date(Date.now() - 1000);

    it('end, and release the seat, when the provider never confirms', async () => {
      const f = await cashBooking();
      const payment = (await Payment.findOne({ bookingId: f.bookingId }))!;

      expect(payment.expiresAt, 'a cash booking has a hold deadline').toBeInstanceOf(Date);
      const hoursLeft = (payment.expiresAt!.getTime() - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(23);
      expect(hoursLeft).toBeLessThanOrEqual(24);
      expect(await seatStatus(f.tripId)).toBe('reserved');

      // Not due yet: nothing happens.
      expect((await expireStalePayments()).expired).toBe(0);

      await Payment.updateOne({ _id: payment._id }, { expiresAt: past() });
      expect((await expireStalePayments()).expired).toBe(1);

      expect((await Booking.findById(f.bookingId))!.bookingStatus).toBe('expired');
      expect((await Payment.findById(payment._id))!.status).toBe('expired');
      expect(await seatStatus(f.tripId)).toBe('available');
    });

    it('never end a booking the provider has confirmed', async () => {
      const f = await cashBooking();
      const confirm = await authed(app, f.provider.token)
        .put(`/api/providers/bookings/${f.bookingId}/status`)
        .send({ status: 'confirmed' });
      expect(confirm.status).toBe(200);

      const payment = (await Payment.findOne({ bookingId: f.bookingId }))!;
      expect(payment.expiresAt, 'confirming clears the hold deadline').toBeUndefined();

      // Even a stale deadline left on a confirmed booking is tidied up, never acted on.
      await Payment.updateOne({ _id: payment._id }, { expiresAt: past() });
      expect((await expireStalePayments()).expired).toBe(0);
      expect((await Booking.findById(f.bookingId))!.bookingStatus).toBe('confirmed');
      expect((await Payment.findById(payment._id))!.expiresAt).toBeUndefined();
      expect(await seatStatus(f.tripId)).toBe('booked');
    });
  });
});
