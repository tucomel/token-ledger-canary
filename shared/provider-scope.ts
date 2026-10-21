/** This fork accounts only for the dedicated Canary API-key provider. */
export const TRACKED_PROVIDER = 'codex-canary';

export function isTrackedProvider(provider: unknown): provider is typeof TRACKED_PROVIDER {
  return provider === TRACKED_PROVIDER;
}
