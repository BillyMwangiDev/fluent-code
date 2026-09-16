/**
 * Stale-while-revalidate memo for answers that come from spawning provider CLIs or asking GitHub:
 * each costs seconds, changes rarely, and is asked for on every screen visit. A fresh value is
 * served as is; a stale one is served at once while a single background reload replaces it; a
 * missing one is loaded (once, however many callers arrive together).
 */
export class Memo<T> {
  private value?: {at: number; data: T};
  private inflight?: Promise<T>;

  constructor(private readonly ttlMs: number, private readonly load: () => Promise<T>) {}

  async get(options: {fresh?: boolean} = {}): Promise<T> {
    if (!options.fresh && this.value) {
      if (Date.now() - this.value.at >= this.ttlMs) void this.refresh().catch(() => undefined);
      return this.value.data;
    }
    return this.refresh();
  }

  /** What is cached right now, without triggering a load. */
  peek(): T | undefined {
    return this.value?.data;
  }

  invalidate() {
    this.value = undefined;
  }

  private refresh(): Promise<T> {
    if (!this.inflight) {
      this.inflight = this.load()
        .then(data => {
          this.value = {at: Date.now(), data};
          return data;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }
}

/** One Memo per key, for per-directory or per-provider answers. */
export class KeyedMemo<T> {
  private readonly memos = new Map<string, Memo<T>>();

  constructor(private readonly ttlMs: number, private readonly load: (key: string) => Promise<T>) {}

  get(key: string, options: {fresh?: boolean} = {}): Promise<T> {
    let memo = this.memos.get(key);
    if (!memo) {
      memo = new Memo(this.ttlMs, () => this.load(key));
      this.memos.set(key, memo);
    }
    return memo.get(options);
  }

  invalidate(key?: string) {
    if (key === undefined) this.memos.clear();
    else this.memos.delete(key);
  }
}
