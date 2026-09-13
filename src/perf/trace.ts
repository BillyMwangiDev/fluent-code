import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {appendPrivateLine, writePrivateJson} from '../security/secure-state.js';
import {redact} from './redaction.js';

export type TraceManifest = {
  schemaVersion: 1;
  createdAt: string;
  fixture: string;
  comparator: string;
  host: Record<string, string | number | undefined>;
  samplesHash: string;
};

/** Redacted local artifact writer. A manifest hashes the exact emitted JSONL before report generation. */
export class TraceWriter {
  private readonly samplesFile: string;
  private readonly manifestFile: string;
  private readonly lines: string[] = [];

  constructor(directory: string) {
    const root = resolve(directory);
    this.samplesFile = join(root, 'samples.jsonl');
    this.manifestFile = join(root, 'manifest.json');
  }

  async sample(value: unknown) {
    const line = JSON.stringify(redact(value));
    this.lines.push(line);
    await appendPrivateLine(this.samplesFile, line);
  }

  async finalize(input: Omit<TraceManifest, 'schemaVersion' | 'createdAt' | 'samplesHash'>) {
    const manifest: TraceManifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      ...input,
      samplesHash: createHash('sha256').update(this.lines.join('\n')).digest('hex')
    };
    await writePrivateJson(this.manifestFile, manifest);
    return manifest;
  }
}
