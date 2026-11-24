import { describe, expect, it } from 'vitest';
import {
  HIDDEN_CONTACT,
  contactWindow,
  maskContactText,
  stripContactDetails,
} from '../src/utils/contactPrivacy';

describe('contact privacy: keep customer ↔ provider contact on Banjara', () => {
  it('hides Pakistani mobiles, landlines, emails and WhatsApp links in text', () => {
    const text =
      'Call 0300 1234567 or +92-345-7654321, office 05811-123456, mail ali@hunza.pk, wa.me/923001234567';
    const out = maskContactText(text);
    expect(out).not.toMatch(/0300|345|05811|ali@|wa\.me/);
    expect(out).toContain(HIDDEN_CONTACT);
  });

  it('leaves dates, times, prices and IDs alone', () => {
    const text = 'Departs 2026-11-12 at 08:30, Rs 24,000, room 204, id 3a70f1eea2325a7ae22e47d3';
    expect(maskContactText(text)).toBe(text);
  });

  it('strips contact keys deeply but keeps image URLs and other fields', () => {
    const payload = {
      success: true,
      data: {
        name: 'Hunza Orchard Hotel',
        phone: '03001234567',
        email: 'owner@hotel.pk',
        images: ['https://cdn.example.com/photo-03001234567.jpg'],
        provider: { businessName: 'Orchard', whatsapp: '+923001234567', rating: 4.6 },
        description: 'Book direct on 0300-1234567!',
      },
    };
    const out = stripContactDetails(payload) as typeof payload;
    expect(out.data).not.toHaveProperty('phone');
    expect(out.data).not.toHaveProperty('email');
    expect(out.data.provider).not.toHaveProperty('whatsapp');
    expect(out.data.provider.rating).toBe(4.6);
    expect(out.data.images[0]).toBe('https://cdn.example.com/photo-03001234567.jpg');
    expect(out.data.description).toBe(`Book direct on ${HIDDEN_CONTACT}!`);
  });

  it('opens contact only for a confirmed booking, 24h before the trip until it ends', () => {
    const trip = { bookingStatus: 'confirmed', tripDate: '2026-11-12', tripDepartureTime: '08:00' };
    const start = Date.parse('2026-11-12T08:00:00+05:00');
    const hour = 60 * 60 * 1000;
    expect(contactWindow(trip, start - 25 * hour).open).toBe(false);
    expect(contactWindow(trip, start - 25 * hour).opensAt).toBe(new Date(start - 24 * hour).toISOString());
    expect(contactWindow(trip, start - 23 * hour).open).toBe(true);
    expect(contactWindow(trip, start + 30 * hour).open).toBe(true);
    expect(contactWindow(trip, start + 80 * hour).open).toBe(false);
    expect(contactWindow({ ...trip, bookingStatus: 'pending' }, start).open).toBe(false);
  });

  it('uses check-in / check-out for hotel stays', () => {
    const stay = { bookingStatus: 'confirmed', checkIn: '2026-11-12', checkOut: '2026-11-15' };
    expect(contactWindow(stay, Date.parse('2026-11-14T12:00:00+05:00')).open).toBe(true);
    expect(contactWindow(stay, Date.parse('2026-11-10T12:00:00+05:00')).open).toBe(false);
  });
});
