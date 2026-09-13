import {Entry} from '@napi-rs/keyring';
import type {ProviderId} from './daemon-protocol.js';

const service = 'codes.fluent.api-key';
const testSecrets = new Map<string, string>();

function accountName(provider: ProviderId, accountId: string) {
  return `${provider}:${accountId}`;
}

/** The daemon is the only process that reads a provider key. Account metadata stays safe to
 * render and persist because the secret itself lives in Keychain/Credential Manager/Secret Service. */
export class SecretStore {
  async set(provider: ProviderId, accountId: string, secret: string) {
    if (process.env.FLUENT_SECRET_STORE === 'memory') {
      testSecrets.set(accountName(provider, accountId), secret);
      return;
    }
    new Entry(service, accountName(provider, accountId)).setPassword(secret);
  }

  async get(provider: ProviderId, accountId: string) {
    if (process.env.FLUENT_SECRET_STORE === 'memory') return testSecrets.get(accountName(provider, accountId));
    return new Entry(service, accountName(provider, accountId)).getPassword() ?? undefined;
  }

  async delete(provider: ProviderId, accountId: string) {
    if (process.env.FLUENT_SECRET_STORE === 'memory') {
      testSecrets.delete(accountName(provider, accountId));
      return;
    }
    new Entry(service, accountName(provider, accountId)).deletePassword();
  }
}
