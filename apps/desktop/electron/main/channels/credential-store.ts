/**
 * Channel credential store (module 04, SPEC §2.1 / §4).
 *
 * Credentials arrive as plaintext over the `channels/save` IPC call and are
 * NEVER returned to the renderer afterwards: `list`/`save` responses only
 * carry a `hasCredentials` flag (see `ChannelAccountView`). Values live in an
 * in-memory Map keyed by secretRef, mirrored into a pluggable secret store.
 *
 * SEAM — `setSecretStore`: the main process will wire a host-backed store
 * (electron `safeStorage` AES-256-GCM, or the host-core secrets table from
 * migration v15) here later. host-core currently exposes only
 * secrets.set/delete/has/getForRuntime — no plain read for main — so the
 * in-memory Map is the v1 source of truth and the store, when installed, is
 * written through opportunistically (`get` prefers the store, falling back to
 * memory when it has no value). Restart-persistence is therefore pending
 * until that wiring lands; nothing else in the framework depends on it.
 *
 * Empty-value protection (FR-IM-02): `put` with an empty/whitespace value is
 * a no-op — a save form that leaves the secret blank must never clobber an
 * existing working credential. Only an explicit `delete` clears a value.
 */

export interface SecretStore {
  set(secretRef: string, value: string): Promise<void>;
  get(secretRef: string): Promise<string | null | undefined>;
  delete(secretRef: string): Promise<void>;
}

export interface ChannelCredentialStore {
  /** Store a credential. Empty/whitespace values are ignored (protection). */
  put(secretRef: string, value: string): Promise<boolean>;
  get(secretRef: string): Promise<string | null>;
  has(secretRef: string): Promise<boolean>;
  delete(secretRef: string): Promise<void>;
  /** Wire the host secret store (see module doc); pass null to detach. */
  setSecretStore(store: SecretStore | null): void;
}

function isBlank(value: string | undefined | null): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

export function createChannelCredentialStore(): ChannelCredentialStore {
  const memory = new Map<string, string>();
  let store: SecretStore | null = null;

  return {
    setSecretStore(next) {
      store = next;
    },

    async put(secretRef, value) {
      if (isBlank(value)) return false; // empty = unchanged; never clears
      memory.set(secretRef, value);
      if (store) {
        try {
          await store.set(secretRef, value);
        } catch {
          // Mirror is best-effort; memory still holds the working value.
        }
      }
      return true;
    },

    async get(secretRef) {
      if (store) {
        try {
          const stored = await store.get(secretRef);
          if (typeof stored === "string" && stored.length > 0) return stored;
        } catch {
          // Fall through to memory.
        }
      }
      return memory.get(secretRef) ?? null;
    },

    async has(secretRef) {
      return (await this.get(secretRef)) !== null;
    },

    async delete(secretRef) {
      memory.delete(secretRef);
      if (store) {
        try {
          await store.delete(secretRef);
        } catch {
          // Memory is already clear; nothing else to do.
        }
      }
    },
  };
}
