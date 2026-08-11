/**
 * Fetches affiliate-network policies from Honey's CDN, transforms them into
 * the nested shape the SDK expects, and caches the raw JSON for 1 hour using
 * the Cache API (no `storage` permission required, survives SW restarts).
 *
 * Public surface:
 *   - await getPolicies()      → Policy[] for new StanddownSDK({ policies })
 *   - OWN_IDENTIFIERS          → RegExp[] for new StanddownSDK({ ownAffiliatePatterns })
 */

//url for fetching policies from the CDN; can be changed to point to a local test server during development/testing
const POLICIES_URL = 'https://cdn.honey.io/standdown-policies.json';
const CACHE_NAME = 'standdown-policies-v1';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCHED_AT_HEADER = 'x-fetched-at';

/**
 * Reshape the CDN's flat networkId-keyed object into the SDK's Policy[] shape.
 * CDN shape:  { [networkId]: { policyId?, name?, sessionDuration, rules } }
 * SDK shape:  Policy[] with nested network metadata + schema/policy versions
 */
function transform(policiesData) {
  return Object.entries(policiesData).map(([networkId, net]) => ({
    id: net.policyId ?? networkId,
    schemaVersion: 2,
    policyVersion: 1,
    network: {
      id: networkId,
      name: net.name ?? networkId,
      sessionDuration: net.sessionDuration,
    },
    rules: net.rules,
  }));
}

/**
 * Returns fresh policies, served from Cache API when the cached copy is < 1h old.
 * Throws on network error, non-2xx response, or malformed JSON — by design:
 * the SDK should not init with empty/silently-wrong rules.
 */
export async function getPolicies() {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(POLICIES_URL);

  if (cached) {
    const fetchedAt = Number(cached.headers.get(FETCHED_AT_HEADER) ?? 0);
    if (Date.now() - fetchedAt < CACHE_TTL_MS) {
      return transform(await cached.json());
    }
  }

  const res = await fetch(POLICIES_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch policies: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  // Re-wrap so we can stamp the fetch time in a header (Cache API has no TTL).
  await cache.put(
    POLICIES_URL,
    new Response(JSON.stringify(json), {
      headers: {
        'content-type': 'application/json',
        [FETCHED_AT_HEADER]: String(Date.now()),
      },
    })
  );

  return transform(json);
}

/**
 * URL patterns identifying clicks we (Honey) originated. The SDK tests every
 * URL in the redirect chain against these and sets `isOwnAffiliateLink: true`
 * when any pattern matches, which suppresses stand-down for our own traffic.
 */
export const OWN_IDENTIFIERS = [
  /pub=5575133559/, // eBay rover: Honey's publisher ID
  /campid=5337727371/, // eBay: Honey's campaign ID
  /awinaffid=214459/, // Awin: Honey's publisher ID
  /click-7229499/, // CJ: Honey's publisher ID (click-PID format)
  /psid=7229499/, // CJ: Honey's publisher ID (psid param)
  /PID_7229499/, // CJ: Honey's publisher ID (PID_ format)
  /_si=7229499/, // CJ: Honey's publisher ID (Macy's-style landing form)
  /mmc=.*118767/, // Impact: Honey's publisher ID
  /o\.honey\.io/, // Honey's own redirector domain — any chain through it is ours
];
