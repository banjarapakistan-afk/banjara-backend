import { describe, expect, it } from 'vitest';
import { publicReviewerName } from '../src/services/review.service';

describe('Home review highlights', () => {
  it('shows a first name and last initial, never a full name', () => {
    expect(publicReviewerName('Ayesha Khan')).toBe('Ayesha K.');
    expect(publicReviewerName('  muhammad  ali  raza ')).toBe('muhammad R.');
    expect(publicReviewerName('Bilal')).toBe('Bilal');
    expect(publicReviewerName('')).toBe('Banjara traveller');
    expect(publicReviewerName(undefined)).toBe('Banjara traveller');
  });
});
