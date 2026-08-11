/**
 * Standdown SDK Audit Log Sample Extension: Background Service Worker
 *
 * Demonstrates the V2 pattern:
 *   - await StanddownSDK.create({ enableAuditLog: true }) at startup
 *   - Affiliate detections are automatically recorded to chrome.storage.local
 *   - Popup and Playwright tests query via sdk.getEventsByDomain(url)
 *
 * sdk.mjs is copied from dist/index.mjs by the test:e2e script before
 * Playwright launches Chrome. It must live inside the extension directory to
 * satisfy Chrome's extension sandboxing rules.
 */

import { StanddownSDK } from './sdk.mjs';

/**
 * Derive the root domain key from a URL string.
 * Matches the 2-label heuristic used by AuditLog internally.
 * Returns null for malformed URLs.
 */
function getRootDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SDK initialisation: synchronous construction so __sdk is available
// immediately for Playwright E2E inspection and navigation listener wiring.
//
// Production note: use `await StanddownSDK.create({ enableAuditLog: true })`
// in a production service worker to ensure the audit log is hydrated from
// chrome.storage.local before the first getEventLog()/getEventsByDomain() call.
// Top-level await is not used here because Chrome MV3 service workers can
// idle-terminate while the storage call is in flight, which would prevent the
// extension from processing the first navigation event after a restart.
// ---------------------------------------------------------------------------

// Affiliate network policies supplied at SDK initialization.
// The SDK no longer bundles default policies; integrators must provide their own.
const POLICIES = [
  // add policies here!
];

const OWN_IDENTIFIERS = [
  /mmc=.*000000/, // Impact: example publisher ID
  /o\.example/, // example redirector domain — any chain through it is ours
];

const sdk = new StanddownSDK({
  policies: POLICIES,
  enableAuditLog: true,
  ownAffiliatePatterns: OWN_IDENTIFIERS,
});

// Expose on globalThis for direct Playwright service worker evaluation.
globalThis.__sdk = sdk;

// Capture raw detection events for E2E inspection.
globalThis.__affiliateEvents = [];

// Tracks which tab last triggered a detection for each root domain.
// Parallel to the SDK's audit log; used by CHECK_AUDIT to include the
// triggering tab ID in the popup response.
const __detectionTabByDomain = new Map();
globalThis.__detectionTabByDomain = __detectionTabByDomain;

// ---------------------------------------------------------------------------
// Resolve the webRequest namespace (same logic as StanddownSDK internally).
// Prefer globalThis.browser (Firefox / Playwright compat layer) when available.
// ---------------------------------------------------------------------------

const _webRequest = (() => {
  try {
    const b = globalThis.browser;
    if (b?.webRequest) return b.webRequest;
  } catch {
    /* ignore */
  }
  return chrome.webRequest;
})();

const _MAIN_FRAME_FILTER = { urls: ['<all_urls>'], types: ['main_frame'] };

// ---------------------------------------------------------------------------
// Navigation listeners: trigger detection on every completed navigation.
//
// onCompleted fires after the final 2xx response, by which point the SDK's
// tracker has finalised the redirect chain. onErrorOccurred covers network
// failures after the affiliate redirect hop has been observed.
// ---------------------------------------------------------------------------

function handleNavigationComplete({ tabId }) {
  if (tabId < 0) return;
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;

  // Track which tab triggered detection for each root domain so the popup
  // can display "Triggered by tab X".
  const lastUrl = result.redirectChain[result.redirectChain.length - 1];
  if (lastUrl) {
    const domain = getRootDomain(lastUrl);
    if (domain) __detectionTabByDomain.set(domain, tabId);
  }
  globalThis.__affiliateEvents.push({ tabId, result, timestamp: Date.now() });
  chrome.runtime.sendMessage({ type: 'AFFILIATE_DETECTED_PUSH', tabId, result }).catch(() => {});
}

_webRequest.onCompleted.addListener(handleNavigationComplete, _MAIN_FRAME_FILTER);
_webRequest.onErrorOccurred.addListener(handleNavigationComplete, _MAIN_FRAME_FILTER);

// ---------------------------------------------------------------------------
// Message handler: popup sends CHECK_AUDIT to query the current tab.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CHECK_AUDIT') return false;

  const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

  if (tabId == null) {
    sendResponse(null);
    return true;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) {
      sendResponse(null);
      return;
    }
    const events = sdk.getEventsByDomain(tab.url);
    const event = events[0] ?? null;
    if (!event) {
      sendResponse(null);
      return;
    }
    const domain = getRootDomain(event.url);
    const triggerTabId = domain ? (__detectionTabByDomain.get(domain) ?? null) : null;
    sendResponse({ event, triggerTabId });
  });

  return true; // keep port open for async response
});
