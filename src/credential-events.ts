import {join} from 'node:path';
import type {CredentialEvent} from './daemon-protocol.js';
import {appendPrivateLine, readPrivateFile} from './security/secure-state.js';

function eventsFile(stateDirectory: string) {
  return join(stateDirectory, 'credential-events.jsonl');
}

/** Appends one credential switch to the durable log. Switches are rare enough that this never
 * needs rotation or compaction, unlike the run event journal. */
export async function appendCredentialEvent(stateDirectory: string, event: CredentialEvent) {
  await appendPrivateLine(eventsFile(stateDirectory), JSON.stringify(event));
}

/** Every switch at or after `sinceMs`, oldest first. A torn final line from an unclean shutdown is
 * dropped rather than treated as a crash — the same tolerance run-store.ts gives its own journal. */
export async function listCredentialEvents(stateDirectory: string, sinceMs: number): Promise<CredentialEvent[]> {
  const log = await readPrivateFile(eventsFile(stateDirectory));
  if (!log) return [];
  const events: CredentialEvent[] = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as CredentialEvent;
      if (Date.parse(event.at) >= sinceMs) events.push(event);
    } catch {
      // A torn final JSONL write was never fsync-complete and must not become a phantom event.
    }
  }
  return events;
}
