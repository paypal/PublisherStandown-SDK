/**
 * Standdown SDK Test Extension: Background Service Worker
 *
 * Imports the built SDK from dist/, instantiates StanddownSDK, and
 * listens for CHECK_STANDDOWN messages from the popup and Playwright tests.
 */

// sdk.mjs is copied from dist/index.mjs by the test:e2e script before Playwright
// launches Chrome. It must live inside the extension directory to satisfy Chrome's
// extension sandboxing rules (extensions cannot import files from outside their root).
import { StanddownSDK } from './sdk.mjs';
import { SessionManager } from './session-manager.js';
import { getPolicies, OWN_IDENTIFIERS } from './fetchpolicy.js';

/**
 * Find which OWN_IDENTIFIERS pattern matched which URL in the chain.
 * Returns the first (url, pattern) pair; the SDK sets isOwnAffiliateLink as
 * soon as any pattern matches any URL, so the first match is what mattered.
 */
function findOwnMatch(chain) {
  for (const url of chain) {
    for (const pattern of OWN_IDENTIFIERS) {
      if (pattern.test(url)) return { url, pattern: pattern.source };
    }
  }
  return null;
}

// Resolve the webRequest namespace the same way StanddownSDK does internally:
// prefer globalThis.browser (Firefox / Playwright compat layer) if it exposes
// webRequest; fall back to chrome. Using the same namespace ensures our
// listeners fire on exactly the same event dispatcher as the SDK's.
const _webRequest = (() => {
  try {
    const b = globalThis.browser;
    if (b?.webRequest) return b.webRequest;
  } catch { /* ignore */ }
  return chrome.webRequest;
})();

const _MAIN_FRAME_FILTER = { urls: ['<all_urls>'], types: ['main_frame'] };

// SDK construction is async because policies are fetched from the CDN.
// Top-level await is disallowed in MV3 service workers, so we expose a
// promise that handlers await before using `sdk`. Listeners below are still
// registered synchronously at top level (required for MV3 wake-from-event
// semantics); events firing before init queue behind the promise.
let sdk = null;
const sdkReady = (async () => {
  sdk = new StanddownSDK({
    policies: await getPolicies(),
    ownAffiliatePatterns: OWN_IDENTIFIERS,
  });
  globalThis.__sdk = sdk;
})();

const sessionManager = new SessionManager();

// Expose on globalThis for direct Playwright service worker evaluation.
// This avoids needing a round-trip through messaging for E2E tests.
globalThis.__sessionManager = sessionManager;

// Capture detection events for E2E tests and dev inspection.
globalThis.__affiliateEvents = [];

// Most recent detection event per tab, keyed by tabId.
// Used by the popup to display detection data without opening DevTools.
globalThis.__latestCallbackByTab = new Map();

// Most recent detection event across all tabs.
// Returned by GET_CALLBACK_EVENT so every popup shows the latest detection
// regardless of which tab triggered it.
globalThis.__latestCallback = null;

// ---------------------------------------------------------------------------

/**
 * Wraps checkForAffiliatePatterns() and produces a shouldStanddown decision.
 * isOwnAffiliateLink is set by the SDK based on the configured ownAffiliatePatterns.
 *
 * Exposed on globalThis so Playwright tests can call it directly via
 * sw.evaluate(() => globalThis.__checkStanddown(tabId)) without a message
 * round-trip. This is test scaffolding; in a real extension this logic
 * belongs inside the onMessage handler only.
 *
 * @param {number} tabId
 * @returns {{ hasAffiliatePattern: boolean, matchedPatterns: object[],
 *             redirectChain: string[], isOwnAffiliateLink: boolean,
 *             shouldStanddown: boolean,
 *             reason: 'no_affiliate_detected'|'own_link'|'competitor_detected' }}
 */
globalThis.__checkStanddown = async function (tabId) {
  await sdkReady;
  const result = sdk.checkForAffiliatePatterns(tabId);
  return {
    ...result,
    isOwnLink: result.isOwnAffiliateLink,
    shouldStanddown: result.hasAffiliatePattern && !result.isOwnAffiliateLink,
    reason: !result.hasAffiliatePattern
      ? 'no_affiliate_detected'
      : result.isOwnAffiliateLink
        ? 'own_link'
        : 'competitor_detected',
  };
};

// Clear per-tab callback state when a tab is closed to keep memory bounded.
// The SDK registers its own tabs.onRemoved listener internally for tracker
// cleanup; this is a separate, independent listener for our popup state.
//
// Skip deletion when an active session exists for that tab's domain: the
// entry is the only way to recover the final URL for a closed tab, which the
// CHECK_STANDDOWN handler needs to look up the session. Cleanup happens lazily
// inside CHECK_STANDDOWN once the session expires.
chrome.tabs.onRemoved.addListener((tabId) => {
  const event = globalThis.__latestCallbackByTab.get(tabId);
  if (!event) return;
  const lastUrl = event.result?.redirectChain?.at(-1) ?? null;
  const session = lastUrl ? sessionManager.getSession(lastUrl) : null;
  if (!session) {
    globalThis.__latestCallbackByTab.delete(tabId);
  }
});

// ---------------------------------------------------------------------------
// Proactive detection on navigation completion.
//
// onCompleted fires after the final 2xx response, by which point the SDK's
// tracker has finalised the redirect chain. onErrorOccurred covers network
// failures that occur after the affiliate redirect hop has been observed.
// ---------------------------------------------------------------------------

async function handleNavigationComplete({ tabId }) {
  await sdkReady;
  if (tabId < 0) return;
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;

  const finalUrl = result.redirectChain[result.redirectChain.length - 1];
  // Only competitor clicks create sessions; own clicks stay visible but don't trigger standdown.
  if (finalUrl && !result.isOwnAffiliateLink) {
    sessionManager.record(finalUrl, result, tabId);
  } else if (result.isOwnAffiliateLink) {
    const match = findOwnMatch(result.redirectChain);
    console.log(
      `[standdown] own affiliate link — skipping stand-down. ` +
      `Matched /${match?.pattern}/ in ${match?.url} (tab ${tabId})`
    );
  }

  const event = { tabId, result, timestamp: Date.now() };
  globalThis.__affiliateEvents.push({ tabId, result });
  globalThis.__latestCallbackByTab.set(tabId, event);
  globalThis.__latestCallback = event;
  chrome.runtime.sendMessage({ type: 'AFFILIATE_DETECTED_PUSH', tabId, result }).catch(() => {});
}

_webRequest.onCompleted.addListener(handleNavigationComplete, _MAIN_FRAME_FILTER);
_webRequest.onErrorOccurred.addListener(handleNavigationComplete, _MAIN_FRAME_FILTER);


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CALLBACK_EVENT') {
    sendResponse(globalThis.__latestCallback ?? null);
    return true;
  }

  if (message.type !== 'CHECK_STANDDOWN') return false;

  const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

  if (tabId == null) {
    sendResponse({
      hasAffiliatePattern: false,
      matchedPatterns: [],
      redirectChain: [],
      isOwnAffiliateLink: false,
      shouldStanddown: false,
      reason: 'no_affiliate_detected',
      session: null,
    });
    return true;
  }

  // Live detection awaits sdkReady (SDK init is async since policies are fetched from CDN).
  globalThis.__checkStanddown(tabId).then((liveResult) => {
  // Session lookup requires the tab's current URL, which is an async operation.
  // chrome.tabs.get may fail if the tab was closed between the message being sent
  // and this handler running; handle gracefully via chrome.runtime.lastError.
  chrome.tabs.get(tabId, (tab) => {
    // When the tab is closed, fall back to the last known URL from callback state
    // so we can still look up an active session for the domain.
    let tabUrl = tab?.url ?? null;
    if (chrome.runtime.lastError || !tabUrl) {
      const lastEvent = globalThis.__latestCallbackByTab.get(tabId);
      tabUrl = lastEvent?.result?.redirectChain?.at(-1) ?? null;
    }

    const session = tabUrl ? sessionManager.getSession(tabUrl) : null;

    // If the session has expired (or never existed), remove the stale entry.
    if (!session) globalThis.__latestCallbackByTab.delete(tabId);

    // Session-based stand-down: a prior session exists AND the link is not own.
    const sessionActive = session !== null && !liveResult.isOwnAffiliateLink;
    const shouldStanddown = liveResult.shouldStanddown || sessionActive;
    const reason = liveResult.shouldStanddown
      ? liveResult.reason
      : sessionActive
        ? 'session_active'
        : liveResult.reason;

    // sdkShouldStanddown / sdkReason are the live SDK decision for THIS tab only,
    // ignoring any session. shouldStanddown / reason are the combined decision
    // (SDK signal OR an active session for the domain).
    sendResponse({
      ...liveResult,
      sdkShouldStanddown: liveResult.shouldStanddown,
      sdkReason: liveResult.reason,
      shouldStanddown,
      reason,
      session,
    });
  });
  });

  return true; // keep port open for async response
});
