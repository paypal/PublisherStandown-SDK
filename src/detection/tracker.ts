/**
 * NavigationTracker: builds and maintains per-tab URL chains from
 * chrome.webRequest.onHeadersReceived events.
 *
 * Status code drives the chain: 3xx responses are buffered as redirect hops,
 * any non-3xx response (2xx/4xx/5xx) closes the chain.
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

/** Payload subset required from chrome.webRequest.onHeadersReceived. */
export interface HeadersReceivedDetails {
  tabId: number;
  url: string;
  type: string;
  statusCode: number;
}

/** Injectable chrome API subset required by NavigationTracker. */
export interface TrackerDeps {
  onHeadersReceived: {
    addListener(
      callback: (details: HeadersReceivedDetails) => void,
      filter: { urls: string[]; types: string[] },
    ): void;
    removeListener(callback: (details: HeadersReceivedDetails) => void): void;
  };
  onTabRemoved: {
    addListener(callback: (tabId: number) => void): void;
    removeListener(callback: (tabId: number) => void): void;
  };
}

/**
 * Builds and maintains per-tab URL chains from webRequest.onHeadersReceived events.
 *
 * 3xx responses buffer the URL as a redirect hop. Any non-3xx response promotes the
 * buffer (plus the final URL, deduplicated) to the tab's chain. A response with no
 * prior buffered hops is treated as a direct navigation.
 */
export class NavigationTracker {
  private readonly tabChains: Map<number, string[]> = new Map();
  private readonly tabRequestBuffers: Map<number, string[]> = new Map();
  private readonly deps: TrackerDeps | undefined;
  private readonly onHeadersReceivedHandler:
    | ((details: HeadersReceivedDetails) => void)
    | undefined;
  private readonly onTabRemovedHandler: ((tabId: number) => void) | undefined;

  /**
   * @param deps  Chrome API event references for testability.
   *              When omitted, no listeners are registered and getChain()
   *              always returns [] (stub mode for backward compatibility).
   */
  constructor(deps?: TrackerDeps) {
    if (deps === undefined) return;

    this.deps = deps;

    this.onHeadersReceivedHandler = ({ tabId, url, type, statusCode }) => {
      if (type !== 'main_frame') return;
      if (tabId < 0) return;

      if (statusCode >= 300 && statusCode <= 399) {
        const buf = this.tabRequestBuffers.get(tabId);
        if (buf !== undefined) {
          buf.push(url);
        } else {
          this.tabRequestBuffers.set(tabId, [url]);
        }
        return;
      }

      const buf = this.tabRequestBuffers.get(tabId);
      if (buf === undefined) {
        this.tabChains.set(tabId, [url]);
        return;
      }

      const seen = new Set<string>();
      const chain: string[] = [];
      for (const u of buf) {
        if (!seen.has(u)) { seen.add(u); chain.push(u); }
      }
      if (!seen.has(url)) chain.push(url);
      this.tabChains.set(tabId, chain);
      this.tabRequestBuffers.delete(tabId);
    };

    this.onTabRemovedHandler = (tabId) => {
      this.tabChains.delete(tabId);
      this.tabRequestBuffers.delete(tabId);
    };

    deps.onHeadersReceived.addListener(
      this.onHeadersReceivedHandler,
      { urls: ['<all_urls>'], types: ['main_frame'] },
    );
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
      this.onHeadersReceivedHandler === undefined ||
      this.onTabRemovedHandler === undefined
    ) return;

    this.deps.onHeadersReceived.removeListener(this.onHeadersReceivedHandler);
    this.deps.onTabRemoved.removeListener(this.onTabRemovedHandler);
    this.tabChains.clear();
    this.tabRequestBuffers.clear();
  }
}
