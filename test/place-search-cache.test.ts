import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPlaceSearchCache, searchPlaces } from '../src/services/location.service';

const photon = {
  features: [
    {
      geometry: { coordinates: [74.1, 35.9] },
      properties: { name: 'Zxqvillage', city: 'Zxqvillage', state: 'Gilgit-Baltistan', country: 'Pakistan' },
    },
  ],
};

describe('place search cache', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearPlaceSearchCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('photon') ? photon : []),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('serves repeated and concurrent searches from one upstream lookup', async () => {
    const [a, b] = await Promise.all([searchPlaces('zxqvillage', 5), searchPlaces('  ZXQVILLAGE ', 5)]);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(a[0].name).toBe('Zxqvillage');
    expect(b).toEqual(a);
    await searchPlaces('Zxqvillage', 5);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('limits Photon to Pakistan and does not cache empty results', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    expect(await searchPlaces('qqqnowhere', 5)).toEqual([]);
    const first = fetchMock.mock.calls.length;
    const photonUrl = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.includes('photon'));
    expect(photonUrl).toContain('bbox=60.87');
    await searchPlaces('qqqnowhere', 5);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
  });
});
