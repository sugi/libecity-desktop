// The SDK has no public "sign in with a refresh token", so it gets handed the
// blob it would have written itself and takes over from there. Two things this
// depends on, both verified by scripts/listen-probe.cjs: initializeAuth
// instantiates what it is given, so this must be a class and not an object;
// and the seeded accessToken is checked against accounts:lookup during
// restore, so it has to be freshly minted.
//
// The SDK also caches persistence instances in a module-level map keyed by the
// class object, with no eviction hook -- deleteApp does not touch it. A fresh
// class per call would pin one more cached instance (and the tokens its closure
// holds) on every restore, for the life of the process. Instead there is
// exactly one class, reading a module-level store that seedPersistence
// re-seeds and clearSeeded empties, so exactly one entry is ever cached.
const seededStore = new Map<string, unknown>();

export class SeededPersistence {
  readonly type = "LOCAL";
  async _isAvailable() {
    return true;
  }
  async _set(k: string, v: unknown) {
    seededStore.set(k, v);
  }
  async _get(k: string) {
    return seededStore.get(k) ?? null;
  }
  async _remove(k: string) {
    seededStore.delete(k);
  }
  _addListener() {}
  _removeListener() {}
}

export function seedPersistence(key: string, blob: unknown): unknown {
  seededStore.clear();
  seededStore.set(key, blob);
  return SeededPersistence;
}

export function clearSeeded(): void {
  seededStore.clear();
}
