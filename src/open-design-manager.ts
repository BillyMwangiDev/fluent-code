import {dirname, join} from 'node:path';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

export type OpenDesignProfile = {url: string};
export type OpenDesignStatus = OpenDesignProfile & {reachable: boolean; status?: number; error?: string};

const defaultProfile: OpenDesignProfile = {url: 'http://127.0.0.1:7456'};

/**
 * A deliberately narrow bridge to a locally-run OpenDesign daemon. It holds no OpenDesign
 * credentials and never proxies requests: its only network operation is a health probe to a
 * loopback URL that the user explicitly chose.
 */
export class OpenDesignManager {
  private profile: OpenDesignProfile = {...defaultProfile};
  private readonly stateFile: string;

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'open-design.json');
  }

  async restore() {
    try {
      const parsed = await readPrivateJson<Partial<OpenDesignProfile>>(this.stateFile);
      if (!parsed) return;
      if (parsed.url) this.profile = {url: normalizeLocalUrl(parsed.url)};
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get() { return {...this.profile}; }

  async save(url: string) {
    this.profile = {url: normalizeLocalUrl(url)};
    await writePrivateJson(this.stateFile, this.profile);
    return this.get();
  }

  async status(): Promise<OpenDesignStatus> {
    try {
      const response = await fetch(this.profile.url, {signal: AbortSignal.timeout(2_500), redirect: 'error'});
      return {...this.profile, reachable: true, status: response.status};
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'connection failed';
      return {...this.profile, reachable: false, error: message};
    }
  }
}

export function normalizeLocalUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new Error('OpenDesign URL must be a valid local http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('OpenDesign URL must use http or https');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('OpenDesign must be a local service (localhost, 127.0.0.1, or [::1])');
  }
  if (parsed.username || parsed.password) throw new Error('OpenDesign URL must not include credentials');
  return parsed.origin;
}
