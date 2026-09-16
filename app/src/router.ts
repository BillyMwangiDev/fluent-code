// The route is the only piece of navigation state. Pages register themselves; `navigate` swaps
// pages, and `refresh` re-runs the current one. A page that mounts live terminals registers a
// cleanup so replacing it releases their streams.

export type Route =
  | {name: 'splash'}
  | {name: 'onboarding'}
  | {name: 'sessions'}
  | {name: 'new-session'}
  | {name: 'active-session'; sessionId: string; review?: 'diff'}
  | {name: 'credentials'}
  | {name: 'usage'}
  | {name: 'spend'}
  | {name: 'source-control'}
  | {name: 'catalog'}
  | {name: 'themes'}
  | {name: 'orchestration'; focus?: string}
  | {name: 'design'}
  | {name: 'preview'}
  | {name: 'remote'};

export type RouteName = Route['name'];

let current: Route = {name: 'splash'};
let renderer: ((route: Route) => Promise<void>) | undefined;
let routeCleanup: (() => void) | undefined;
let generation = 0;
const listeners = new Set<(route: Route) => void>();

export function route(): Route { return current; }

export function setRenderer(fn: (route: Route) => Promise<void>) { renderer = fn; }

export function onRouteChange(listener: (route: Route) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function navigate(next: Route) {
  current = next;
  for (const listener of listeners) listener(next);
  void refresh();
}

/** Re-renders the current route. Pages call this after an action when their own data changed and
 * they have no cheaper in-place update. */
export async function refresh() {
  const mine = ++generation;
  routeCleanup?.();
  routeCleanup = undefined;
  await renderer?.(current);
  // A render that finished after a newer render started must not leave its cleanup registered.
  if (mine !== generation) return;
}

/** Registers what a page releases when it is replaced. A render that finishes after a newer render
 * already replaced its page releases at once, instead of overwriting the current page's cleanup
 * and leaking every terminal and subscription that page mounted. */
export function setRouteCleanup(page: HTMLElement, cleanup: () => void) {
  if (!page.isConnected) return cleanup();
  const previous = routeCleanup;
  routeCleanup = previous ? () => { previous(); cleanup(); } : cleanup;
}
