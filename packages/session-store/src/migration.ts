import { KernError, SESSION_ENTRY_VERSION, type SessionEntry } from "@kern/protocol";

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  entries: SessionEntry[];
  migratedCount: number;
}

/**
 * Migrate persisted session entries from an older format version up to the
 * current SESSION_ENTRY_VERSION. Fails closed if an entry stream comes from
 * an unsupported future format version.
 */
export function migrateSessionEntries(entries: SessionEntry[]): MigrationResult {
  if (entries.length === 0) {
    return { fromVersion: SESSION_ENTRY_VERSION, toVersion: SESSION_ENTRY_VERSION, entries, migratedCount: 0 };
  }

  const header = entries.find((e) => e.type === "session_header");
  const fromVersion = header && header.type === "session_header" ? header.version : 1;

  if (fromVersion > SESSION_ENTRY_VERSION) {
    throw new KernError(
      "E_SESSION_MIGRATION",
      `Unsupported session version ${fromVersion} (current supported version: ${SESSION_ENTRY_VERSION}). Upgrade Kern to read this session.`,
      { details: { fromVersion, currentVersion: SESSION_ENTRY_VERSION } },
    );
  }

  if (fromVersion === SESSION_ENTRY_VERSION) {
    return { fromVersion, toVersion: SESSION_ENTRY_VERSION, entries, migratedCount: 0 };
  }

  // v1 -> v2: v2 adds optional `usage` entries and `tokensBefore` on compaction entries.
  // All v1 entries remain structurally valid; normalize header version to v2 in memory.
  let migratedCount = 0;
  const out = entries.map((entry) => {
    if (entry.type === "session_header" && entry.version < SESSION_ENTRY_VERSION) {
      migratedCount += 1;
      return { ...entry, version: SESSION_ENTRY_VERSION };
    }
    return entry;
  });

  return {
    fromVersion,
    toVersion: SESSION_ENTRY_VERSION,
    entries: out,
    migratedCount,
  };
}
