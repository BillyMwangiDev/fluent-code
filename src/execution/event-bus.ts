import {randomUUID} from 'node:crypto';
import type {Run, RunEvent} from './types.js';
import type {RunStore} from './run-store.js';

export type StreamDelivery =
  | {kind: 'event'; event: RunEvent}
  | {kind: 'resync-required'; runId: string; from: number; snapshot: Run; terminalGap: boolean};

type Subscriber = {
  runId: string;
  listener: (delivery: StreamDelivery) => boolean | void;
  paused: boolean;
  queue: RunEvent[];
  terminalGap: boolean;
  resyncRequired: boolean;
};

/**
 * A bounded subscriber buffer. Text deltas are explicitly lossy under pressure; state and
 * approval clients instead receive a durable-cursor resync signal and a fresh run snapshot.
 */
export class RunEventBus {
  private readonly subscribers = new Map<string, Subscriber>();

  constructor(private readonly store: RunStore, private readonly maxBufferedEvents = 256) {}

  subscribe(runId: string, afterSequence: number | undefined, listener: Subscriber['listener'], skipInitial = false) {
    const initial = this.store.eventsSince(runId, afterSequence);
    const id = randomUUID();
    const subscriber: Subscriber = {runId, listener, paused: false, queue: [], terminalGap: false, resyncRequired: initial.resyncRequired};
    this.subscribers.set(id, subscriber);
    if (skipInitial) return id;
    if (initial.resyncRequired) {
      listener({kind: 'resync-required', runId, from: afterSequence ?? 0, snapshot: this.store.get(runId), terminalGap: true});
    } else {
      for (const event of initial.events) this.deliver(subscriber, {kind: 'event', event});
    }
    return id;
  }

  unsubscribe(id: string) { this.subscribers.delete(id); }

  pause(id: string) { const subscriber = this.subscribers.get(id); if (subscriber) subscriber.paused = true; }

  resume(id: string) {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    subscriber.paused = false;
    if (subscriber.resyncRequired || subscriber.terminalGap) {
      subscriber.queue = [];
      subscriber.resyncRequired = false;
      const accepted = this.deliver(subscriber, {kind: 'resync-required', runId: subscriber.runId, from: 0, snapshot: this.store.get(subscriber.runId), terminalGap: subscriber.terminalGap});
      subscriber.terminalGap = false;
      if (!accepted) subscriber.paused = true;
      return;
    }
    while (!subscriber.paused && subscriber.queue.length > 0) {
      const event = subscriber.queue.shift()!;
      if (!this.deliver(subscriber, {kind: 'event', event})) subscriber.paused = true;
    }
  }

  publish(event: RunEvent) {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.runId !== event.runId) continue;
      if (!subscriber.paused && subscriber.queue.length === 0) {
        if (!this.deliver(subscriber, {kind: 'event', event})) subscriber.paused = true;
        continue;
      }
      this.enqueue(subscriber, event);
    }
  }

  private enqueue(subscriber: Subscriber, event: RunEvent) {
    const terminal = event.type === 'text.delta';
    if (subscriber.queue.length >= this.maxBufferedEvents) {
      if (terminal) {
        subscriber.terminalGap = true;
        return;
      }
      const firstTerminal = subscriber.queue.findIndex(candidate => candidate.type === 'text.delta');
      if (firstTerminal >= 0) {
        subscriber.queue.splice(firstTerminal, 1);
        subscriber.terminalGap = true;
      } else {
        // A peer unable to drain lifecycle traffic cannot receive a faithful sequence. It gets a
        // snapshot/resync on drain or reconnect rather than a false claim of an exact replay.
        subscriber.resyncRequired = true;
        return;
      }
    }
    subscriber.queue.push(event);
  }

  private deliver(subscriber: Subscriber, delivery: StreamDelivery) {
    return subscriber.listener(delivery) !== false;
  }
}
