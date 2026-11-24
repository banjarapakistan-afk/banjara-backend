/**
 * Keep customer ↔ provider contact inside Banjara.
 *
 * Banjara earns its commission on bookings made through the platform. If a customer can read a
 * provider's phone number, email or WhatsApp from a listing (or a chat) before booking, they can
 * arrange the trip privately. So:
 *  - public catalog data never carries provider contact details for customers or guests;
 *  - phone numbers / emails written into free text (descriptions, chat) are hidden;
 *  - a provider's number is released only for a confirmed booking, close to the travel date.
 */
import type { NextFunction, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware';

/** Keys that hold contact details anywhere in a public payload. */
const CONTACT_KEYS = new Set(
  [
    'phone',
    'phoneNumber',
    'mobile',
    'mobileNumber',
    'whatsapp',
    'whatsApp',
    'whatsappNumber',
    'email',
    'contactPhone',
    'contactEmail',
    'contactNumber',
    'driverPhone',
    'driverEmergencyContact',
    'emergencyContact',
    'alternatePhone',
    'landline',
    'website',
    'providerPhone',
    'providerEmail',
    'ownerPhone',
    'ownerEmail',
  ].map((key) => key.toLowerCase()),
);

export const HIDDEN_CONTACT = '[contact hidden · message on Banjara]';

const PATTERNS = [
  // Pakistani mobiles: 0300 1234567, +92 300-1234567, 0092 300 1234567
  /(?<![\w+])(?:\+?92|0092|0)[\s.-]?3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g,
  // Landlines: 051-1234567, 05811 123456
  /(?<![\w+])0\d{2,4}[\s-]?\d{6,7}(?!\w)/g,
  // Other international numbers: +44 20 7946 0958
  /(?<!\w)\+\d[\d\s.-]{8,15}\d(?!\w)/g,
  // Emails
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // WhatsApp links
  /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/[^\s]*/gi,
];

/** Hide phone numbers, emails and WhatsApp links written into free text. */
export function maskContactText(text: string, replacement = HIDDEN_CONTACT): string {
  return PATTERNS.reduce((out, pattern) => out.replace(pattern, replacement), text);
}

/** URLs and paths (images, links) are left alone: their digits are not phone numbers. */
function looksLikeUrl(value: string) {
  return /^(?:https?:|data:|\/)/i.test(value) || value.includes('://');
}

/** Deep-copies a JSON payload without contact keys, masking contact details in text. */
export function stripContactDetails(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return looksLikeUrl(value) ? value : maskContactText(value);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  // Mongo ObjectIds, Buffers and similar: let JSON serialise them as usual.
  if (typeof (value as { toHexString?: unknown }).toHexString === 'function') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stripContactDetails(item, seen));
  const source =
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (!source || typeof source !== 'object') return source;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source as Record<string, unknown>)) {
    if (CONTACT_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripContactDetails(child, seen);
  }
  return out;
}

/**
 * Express middleware for public catalog routers (hotels, trips, guides, tours, providers…).
 * Customers and guests get the payload without provider contact details. Providers (managing
 * their own listings) and admins see everything.
 */
export function hideProviderContact(req: AuthRequest, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    const role = req.user?.role;
    if (role === 'provider' || role === 'admin') return json(body);
    return json(stripContactDetails(body));
  };
  next();
}

/** Contact opens this long before the trip starts and stays open this long after it ends. */
export const CONTACT_LEAD_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-12" (+ optional "08:30") as a Pakistan-time instant. */
function pkt(date: unknown, time?: unknown): number | null {
  if (!date) return null;
  if (date instanceof Date) return date.getTime();
  const day = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const parsed = Date.parse(String(date));
    return Number.isNaN(parsed) ? null : parsed;
  }
  const clock = /^\d{1,2}:\d{2}/.test(String(time ?? '')) ? String(time).slice(0, 5).padStart(5, '0') : '00:00';
  const parsed = Date.parse(`${day}T${clock}:00+05:00`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The enriched booking fields contactWindow reads (see booking.service enrichBookings). */
export type ContactWindowBooking = {
  bookingStatus?: unknown;
  tripDate?: unknown;
  tripDepartureTime?: unknown;
  tripArrivalDate?: unknown;
  tripReturnDate?: unknown;
  checkIn?: unknown;
  checkOut?: unknown;
  packageStartDate?: unknown;
  packageDurationDays?: unknown;
  guideBooking?: unknown;
};

/**
 * When the customer may see the provider's number for this booking: only once it is confirmed,
 * from 24 hours before the trip starts until 24 hours after it ends.
 */
export function contactWindow(booking: ContactWindowBooking, now = Date.now()) {
  const guide = (booking.guideBooking ?? {}) as Record<string, unknown>;
  const start =
    pkt(booking.tripDate, booking.tripDepartureTime) ??
    pkt(booking.checkIn, '14:00') ??
    pkt(booking.packageStartDate) ??
    pkt(guide.date, guide.startTime);
  if (start === null) return { open: false, opensAt: null as string | null };
  const lastDay =
    pkt(booking.tripReturnDate) ??
    pkt(booking.tripArrivalDate) ??
    pkt(booking.checkOut) ??
    (booking.packageStartDate && booking.packageDurationDays
      ? start + Math.max(0, Number(booking.packageDurationDays) - 1) * DAY_MS
      : null) ??
    start;
  const opensAt = start - CONTACT_LEAD_MS;
  const closesAt = lastDay + DAY_MS + CONTACT_LEAD_MS;
  const confirmed = booking.bookingStatus === 'confirmed';
  return {
    open: confirmed && now >= opensAt && now <= closesAt,
    opensAt: confirmed && now < opensAt ? new Date(opensAt).toISOString() : null,
  };
}
