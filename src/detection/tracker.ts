/**
 * NavigationTracker: builds and maintains per-tab URL chains from
 * chrome.webRequest and chrome.webNavigation events.
 *
 * Injectable deps allow full unit testing without a real browser.
 * In production, StanddownSDK wires the real browser APIs into TrackerDeps.
 *
 * @example
 * ```ts
 * // Production: StanddownSDK creates with real browser APIs
 * const tracker = new NavigationTracker(realDeps);
 *
 * // Tests: inject mocks
 * const tracker = new NavigationTracker(mockDeps);
 *
 * // Stub mode: no listeners registered, getChain() always returns []
 * const tracker = new NavigationTracker();
 * ```
 */

/** Payload subset required from chrome.webRequest.onBeforeRequest. */
export interface BeforeRequestDetails {
  tabId: number;
  url: string;
  type: string;
  frameId: number;
}

/** Payload subset required from chrome.webNavigation.onBeforeNavigate. */
export interface BeforeNavigateDetails {
  tabId: number;
  url: string;
  frameId: number;
}

/** Payload subset required from chrome.webNavigation.onCommitted. */
export interface CommittedDetails {
  tabId: number;
  url: string;
  frameId: number;
  /** Chrome and Firefox deliver string[]. Safari delivers null. */
  transitionQualifiers: string[] | null;
}

/**
 * Injectable chrome API subset required by NavigationTracker.
 *
 * Exactly one of onBeforeRequest or onBeforeNavigate must be provided:
 * - onBeforeRequest (webRequest mode): preferred; captures all intermediate HTTP hops
 *   including server-side 3xx redirects. Requires the "webRequest" manifest permission.
 * - onBeforeNavigate (navigation-only mode): fallback when webRequest is unavailable
 *   (e.g. Safari Mobile, or when "webRequest" is not declared). Captures only the
 *   initiating URL per redirect chain; intermediate server-side hops are invisible,
 *   but affiliate tracking parameters typically survive to the final committed URL.
 */
export interface TrackerDeps {
  onBeforeRequest?: {
    addListener(
      callback: (details: BeforeRequestDetails) => void,
      filter: { urls: string[]; types: string[] },
    ): void;
    removeListener(callback: (details: BeforeRequestDetails) => void): void;
  };
  onBeforeNavigate?: {
    addListener(callback: (details: BeforeNavigateDetails) => void): void;
    removeListener(callback: (details: BeforeNavigateDetails) => void): void;
  };
  onCommitted: {
    addListener(callback: (details: CommittedDetails) => void): void;
    removeListener(callback: (details: CommittedDetails) => void): void;
  };
  onTabRemoved: {
    addListener(callback: (tabId: number) => void): void;
    removeListener(callback: (tabId: number) => void): void;
  };
}

/**
 * Builds and maintains per-tab URL chains from webRequest and webNavigation events.
 *
 * Two buffer-source modes are supported:
 * - webRequest mode (onBeforeRequest): captures all HTTP hops; preferred when available.
 * - navigation-only mode (onBeforeNavigate): captures only the initiating URL per chain;
 *   used when webRequest is unavailable (e.g. Safari Mobile).
 *
 * In both modes, onCommitted settles the chain. Safari redirect detection: null
 * transitionQualifiers + buffered URL differs from committed URL means a redirect
 * occurred. Equal URLs mean direct navigation.
 */
export class NavigationTracker {
  private readonly tabChains: Map<number, string[]> = new Map();
  private readonly tabRequestBuffers: Map<number, string[]> = new Map();
  private readonly deps: TrackerDeps | undefined;
  private readonly onBeforeRequestHandler: ((details: BeforeRequestDetails) => void) | undefined;
  private readonly onBeforeNavigateHandler: ((details: BeforeNavigateDetails) => void) | undefined;
  private readonly onCommittedHandler: ((details: CommittedDetails) => void) | undefined;
  private readonly onTabRemovedHandler: ((tabId: number) => void) | undefined;

  /**
   * @param deps  Chrome API event references for testability.
   *              When omitted, no listeners are registered and getChain()
   *              always returns [] (stub mode for backward compatibility).
   */
  constructor(deps?: TrackerDeps) {
    if (deps === undefined) return;

    this.deps = deps;

    if (deps.onBeforeRequest !== undefined) {
      this.onBeforeRequestHandler = ({ tabId, url, type, frameId }) => {
        if (type !== 'main_frame') return;
        if (frameId !== 0) return;
        if (tabId < 0) return;
        const buf = this.tabRequestBuffers.get(tabId);
        if (buf !== undefined) {
          buf.push(url);
        } else {
          this.tabRequestBuffers.set(tabId, [url]);
        }
      };
      deps.onBeforeRequest.addListener(
        this.onBeforeRequestHandler,
        { urls: ['<all_urls>'], types: ['main_frame'] },
      );
    } else if (deps.onBeforeNavigate !== undefined) {
      this.onBeforeNavigateHandler = ({ tabId, url, frameId }) => {
        if (frameId !== 0) return;
        if (tabId < 0) return;
        const buf = this.tabRequestBuffers.get(tabId);
        if (buf !== undefined) {
          buf.push(url);
        } else {
          this.tabRequestBuffers.set(tabId, [url]);
        }
      };
      deps.onBeforeNavigate.addListener(this.onBeforeNavigateHandler);
    }

    this.onCommittedHandler = ({ tabId, url, frameId, transitionQualifiers }) => {
      if (frameId !== 0) return;

      const qualifiers = transitionQualifiers ?? [];
      const isRedirectByQualifier =
        qualifiers.includes('server_redirect') ||
        qualifiers.includes('client_redirect') ||
        qualifiers.includes('redirect');

      const buf = this.tabRequestBuffers.get(tabId);

      // Safari: qualifiers are null or undefined (iOS delivers undefined, macOS null).
      // If the buffered URL differs from the committed URL, a server-side redirect
      // occurred — the buffered URL was the entry point and the committed URL is where
      // it resolved. Equal URLs indicate direct navigation with no redirect.
      // Loose equality (== null) matches both null and undefined; gated on nullish
      // specifically so this path never activates on Chrome or Firefox (string[]).
      const isRedirectBySafariHeuristic =
        transitionQualifiers == null &&
        buf !== undefined &&
        buf.length > 0 &&
        buf[buf.length - 1] !== url;

      if (!isRedirectByQualifier && !isRedirectBySafariHeuristic) {
        this.tabRequestBuffers.delete(tabId);
        this.tabChains.set(tabId, [url]);
      } else {
        // Deduplicate buffer in insertion order; guard that committed URL is present.
        const seen = new Set<string>();
        const chain: string[] = [];
        for (const u of buf ?? []) {
          if (!seen.has(u)) { seen.add(u); chain.push(u); }
        }
        if (!seen.has(url)) chain.push(url);
        this.tabChains.set(tabId, chain);
        this.tabRequestBuffers.delete(tabId);
      }
    };

    this.onTabRemovedHandler = (tabId) => {
      this.tabChains.delete(tabId);
      this.tabRequestBuffers.delete(tabId);
    };

    deps.onCommitted.addListener(this.onCommittedHandler);
    deps.onTabRemoved.addListener(this.onTabRemovedHandler);
  }

  /**
   * Returns the current URL chain for the given tab.
   * Returns [] if the tab is unknown or no navigation has been observed.
   */
  getChain(tabId: number): string[] {
    return this.tabChains.get(tabId) ?? [];
  }

  /**
   * Removes all registered browser event listeners and clears per-tab state.
   *
   * Call this when discarding a StanddownSDK instance to prevent ghost listeners
   * from firing against stale state for the lifetime of the service worker.
   * No-op when the tracker was constructed in stub mode (no deps).
   */
  destroy(): void {
    if (
      this.deps === undefined ||
      this.onCommittedHandler === undefined ||
      this.onTabRemovedHandler === undefined
    ) return;

    if (this.onBeforeRequestHandler !== undefined) {
      this.deps.onBeforeRequest!.removeListener(this.onBeforeRequestHandler);
    }
    if (this.onBeforeNavigateHandler !== undefined) {
      this.deps.onBeforeNavigate!.removeListener(this.onBeforeNavigateHandler);
    }
    this.deps.onCommitted.removeListener(this.onCommittedHandler);
    this.deps.onTabRemoved.removeListener(this.onTabRemovedHandler);
    this.tabChains.clear();
    this.tabRequestBuffers.clear();
  }
}
