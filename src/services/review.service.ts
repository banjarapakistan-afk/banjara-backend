import mongoose from 'mongoose';
import { Booking } from '../models/Booking';
import { ProviderProfile } from '../models/ProviderProfile';
import { Review } from '../models/Review';
import { AppError, assertFound } from '../utils/AppError';
import * as notificationService from './notification.service';

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function resolveOverall(input: {
  rating?: number;
  paymentRating?: number;
  serviceRating?: number;
}) {
  if (input.paymentRating != null && input.serviceRating != null) {
    return round1((input.paymentRating + input.serviceRating) / 2);
  }
  if (input.rating != null) return input.rating;
  throw new AppError('Rating is required', 400);
}

function mapServiceType(bookingType: string): 'transport' | 'hotel' | 'tour' | 'guide' {
  if (bookingType === 'hotel') return 'hotel';
  if (bookingType === 'package') return 'tour';
  if (bookingType === 'guide') return 'guide';
  return 'transport';
}

function canReviewBooking(booking: InstanceType<typeof Booking>) {
  if (booking.bookingStatus === 'cancelled' || booking.bookingStatus === 'expired') {
    return false;
  }
  if (booking.bookingStatus === 'completed') return true;
  // After successful payment / confirmation — customer can rate payment + service so far.
  const paid = ['paid', 'confirmed'].includes(String(booking.paymentStatus));
  const confirmed = ['confirmed', 'pending', 'payment_verification'].includes(
    String(booking.bookingStatus)
  );
  return paid && confirmed;
}

async function recomputeProviderRating(providerId: mongoose.Types.ObjectId) {
  const stats = await Review.aggregate([
    { $match: { providerId } },
    {
      $group: {
        _id: '$providerId',
        avg: { $avg: '$rating' },
        avgPayment: { $avg: '$paymentRating' },
        avgService: { $avg: '$serviceRating' },
        count: { $sum: 1 },
      },
    },
  ]);
  const row = stats[0];
  await ProviderProfile.findByIdAndUpdate(providerId, {
    rating: row ? round1(row.avg) : 0,
    totalReviews: row ? row.count : 0,
  });
}

function serializeReview(doc: InstanceType<typeof Review>) {
  return {
    id: doc._id.toString(),
    _id: doc._id.toString(), // Preserve existing API clients alongside the public id.
    bookingId: doc.bookingId.toString(),
    customerId: doc.customerId.toString(),
    providerId: doc.providerId.toString(),
    serviceType: doc.serviceType,
    rating: doc.rating,
    paymentRating: doc.paymentRating ?? null,
    serviceRating: doc.serviceRating ?? null,
    comment: doc.comment ?? '',
    paymentComment: doc.paymentComment ?? '',
    serviceComment: doc.serviceComment ?? '',
    categories: doc.categories ?? {},
    providerReply: doc.providerReply ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function createReview(
  customerId: string,
  input: {
    bookingId: string;
    rating?: number;
    paymentRating?: number;
    serviceRating?: number;
    comment?: string;
    paymentComment?: string;
    serviceComment?: string;
    categories?: Record<string, number>;
  }
) {
  const booking = assertFound(await Booking.findById(input.bookingId), 'Booking not found');
  if (booking.customerId.toString() !== customerId) throw new AppError('Forbidden', 403);
  if (!canReviewBooking(booking)) {
    throw new AppError(
      'You can rate after payment is confirmed or the booking is completed',
      400
    );
  }

  const existing = await Review.findOne({ bookingId: booking._id });
  if (existing) throw new AppError('You already rated this booking', 409);

  const paymentRating = input.paymentRating ?? input.categories?.payment;
  const serviceRating = input.serviceRating ?? input.categories?.service;
  const overall = resolveOverall({
    rating: input.rating,
    paymentRating,
    serviceRating,
  });

  const categories = {
    ...(input.categories ?? {}),
    ...(paymentRating != null ? { payment: paymentRating } : {}),
    ...(serviceRating != null ? { service: serviceRating } : {}),
  };

  const review = await Review.create({
    bookingId: booking._id,
    customerId,
    providerId: booking.providerId,
    serviceType: mapServiceType(booking.bookingType),
    rating: overall,
    paymentRating,
    serviceRating,
    comment: input.comment?.trim() ?? '',
    paymentComment: input.paymentComment?.trim() ?? '',
    serviceComment: input.serviceComment?.trim() ?? '',
    categories,
  });

  await recomputeProviderRating(booking.providerId);

  const provider = await ProviderProfile.findById(booking.providerId).select('userId');
  if (provider?.userId) {
    await notificationService.createNotification({
      userId: provider.userId.toString(),
      type: 'newReview',
      title: 'New customer rating',
      message: `You received ${overall}/5 (payment ${paymentRating ?? '—'} · service ${serviceRating ?? '—'})`,
      data: { reviewId: review._id.toString(), bookingId: booking._id.toString() },
    });
  }

  await notificationService.createNotification({
    userId: customerId,
    type: 'newReview',
    title: 'Thanks for your rating',
    message: 'Your feedback helps other travelers choose with confidence.',
    data: { reviewId: review._id.toString() },
  });

  return serializeReview(review);
}

export async function getReviewForBooking(customerId: string, bookingId: string) {
  const booking = assertFound(await Booking.findById(bookingId), 'Booking not found');
  if (booking.customerId.toString() !== customerId) throw new AppError('Forbidden', 403);
  const review = await Review.findOne({ bookingId: booking._id });
  return review ? serializeReview(review) : null;
}

export async function listProviderReviews(providerId: string) {
  const rows = await Review.find({ providerId }).sort({ createdAt: -1 });
  return rows.map(serializeReview);
}

export async function updateReview(
  customerId: string,
  id: string,
  patch: {
    rating?: number;
    paymentRating?: number;
    serviceRating?: number;
    comment?: string;
    paymentComment?: string;
    serviceComment?: string;
    categories?: Record<string, number>;
  }
) {
  const review = assertFound(await Review.findById(id), 'Review not found');
  if (review.customerId.toString() !== customerId) throw new AppError('Forbidden', 403);

  if (patch.paymentRating != null) review.paymentRating = patch.paymentRating;
  if (patch.serviceRating != null) review.serviceRating = patch.serviceRating;
  if (patch.comment != null) review.comment = patch.comment;
  if (patch.paymentComment != null) review.paymentComment = patch.paymentComment;
  if (patch.serviceComment != null) review.serviceComment = patch.serviceComment;
  if (patch.categories != null) review.categories = patch.categories;

  const paymentRating = review.paymentRating ?? patch.categories?.payment;
  const serviceRating = review.serviceRating ?? patch.categories?.service;
  if (paymentRating != null && serviceRating != null) {
    review.rating = resolveOverall({ paymentRating, serviceRating });
    review.categories = {
      ...(review.categories ?? {}),
      payment: paymentRating,
      service: serviceRating,
    };
  } else if (patch.rating != null) {
    review.rating = patch.rating;
  }

  await review.save();
  await recomputeProviderRating(review.providerId);
  return serializeReview(review);
}

export async function replyToReview(providerId: string, id: string, reply: string) {
  const review = assertFound(await Review.findById(id), 'Review not found');
  if (review.providerId.toString() !== providerId) throw new AppError('Forbidden', 403);
  review.providerReply = reply;
  await review.save();
  return serializeReview(review);
}

/** "Ayesha Khan" → "Ayesha K." — enough to feel real, without publishing full names. */
export function publicReviewerName(name: unknown) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Banjara traveller';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/** Shortest comment worth showing on Home ("Good" alone doesn't help anyone decide). */
const HIGHLIGHT_MIN_CHARS = 20;
const HIGHLIGHT_TTL_MS = 5 * 60 * 1000;
let highlightCache: { at: number; limit: number; value: unknown } | null = null;

/**
 * Real reviews for the Home page: overall rating + recent 4★/5★ reviews with a written comment.
 * Only verified-booking reviews exist (one per booking), so nothing here is invented.
 */
export async function listReviewHighlights(limit = 6) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 6, 1), 12);
  if (highlightCache && highlightCache.limit === safeLimit && Date.now() - highlightCache.at < HIGHLIGHT_TTL_MS) {
    return highlightCache.value;
  }

  const [stats] = await Review.aggregate<{ average: number; total: number }>([
    { $group: { _id: null, average: { $avg: '$rating' }, total: { $sum: 1 } } },
  ]);
  const rows = await Review.find({
    rating: { $gte: 4 },
    $expr: { $gte: [{ $strLenCP: { $ifNull: ['$comment', ''] } }, HIGHLIGHT_MIN_CHARS] },
  })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean();

  const ids = (key: 'customerId' | 'providerId' | 'bookingId') => [...new Set(rows.map((r) => String(r[key])))];
  const User = mongoose.model('User');
  const [customers, providers, bookings] = await Promise.all([
    User.find({ _id: { $in: ids('customerId') } }).select('name avatar').lean<Array<{ _id: unknown; name?: string; avatar?: string }>>(),
    ProviderProfile.find({ _id: { $in: ids('providerId') } }).select('businessName city').lean(),
    Booking.find({ _id: { $in: ids('bookingId') } })
      .select('bookingType transportBooking.tripId hotelBooking.hotelId packageBooking.title packageBooking.destination')
      .lean(),
  ]);
  const tripIds = bookings.map((b) => String(b.transportBooking?.tripId ?? '')).filter((id) => mongoose.isValidObjectId(id));
  const hotelIds = bookings.map((b) => String(b.hotelBooking?.hotelId ?? '')).filter((id) => mongoose.isValidObjectId(id));
  const [trips, hotels] = await Promise.all([
    tripIds.length
      ? mongoose.model('Trip').find({ _id: { $in: tripIds } }).select('origin destination').lean<Array<{ _id: unknown; origin?: string; destination?: string }>>()
      : [],
    hotelIds.length
      ? mongoose.model('Hotel').find({ _id: { $in: hotelIds } }).select('name city').lean<Array<{ _id: unknown; name?: string; city?: string }>>()
      : [],
  ]);
  const byId = <T extends { _id: unknown }>(list: T[]) => new Map(list.map((item) => [String(item._id), item]));
  const customerMap = byId(customers);
  const providerMap = byId(providers);
  const bookingMap = byId(bookings);
  const tripMap = byId(trips);
  const hotelMap = byId(hotels);

  const items = rows.map((review) => {
    const customer = customerMap.get(String(review.customerId));
    const provider = providerMap.get(String(review.providerId));
    const booking = bookingMap.get(String(review.bookingId));
    const trip = tripMap.get(String(booking?.transportBooking?.tripId ?? ''));
    const hotel = hotelMap.get(String(booking?.hotelBooking?.hotelId ?? ''));
    const routeLabel = trip?.origin && trip?.destination ? `${trip.origin} → ${trip.destination}` : null;
    return {
      id: String(review._id),
      rating: review.rating,
      comment: String(review.comment ?? '').trim(),
      serviceType: review.serviceType,
      reviewerName: publicReviewerName(customer?.name),
      reviewerAvatar: customer?.avatar || null,
      providerName: provider?.businessName ?? null,
      providerId: String(review.providerId),
      /** What was booked: "Islamabad → Hunza", "Hunza Orchard Hotel", or the tour title. */
      tripLabel:
        routeLabel ||
        hotel?.name ||
        booking?.packageBooking?.title ||
        null,
      place: hotel?.city || trip?.destination || booking?.packageBooking?.destination || provider?.city || null,
      createdAt: review.createdAt,
    };
  });

  const value = {
    average: stats ? Math.round(stats.average * 10) / 10 : null,
    total: stats?.total ?? 0,
    items,
  };
  highlightCache = { at: Date.now(), limit: safeLimit, value };
  return value;
}
