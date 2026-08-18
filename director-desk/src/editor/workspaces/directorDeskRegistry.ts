export interface DirectorDeskRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const DIRECTOR_DESK_REGISTRY_KEY = "standalone-3d-director-desk-registry-v1";
const ACTIVE_DIRECTOR_DESK_ID_KEY = "standalone-3d-director-desk-active-id-v1";
const DIRECTOR_DESK_ID_PREFIX = "desk_";
const LEGACY_DIRECTOR_SCENE_STORAGE_KEY = "storyai-3d-director-desk-demo";
const LEGACY_DIRECTOR_SCENE_STORAGE_KEY_PREFIX = `${LEGACY_DIRECTOR_SCENE_STORAGE_KEY}:`;

function getStorageSafe() {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDirectorDeskName(name: string) {
  const trimmedName = name.trim();
  const defaultNameMatch = trimmedName.match(/^导演台\s*(\d+)\s*号$/);
  return defaultNameMatch ? `导演台 ${Number(defaultNameMatch[1])} 号` : trimmedName;
}

function normalizeRecord(value: unknown): DirectorDeskRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DirectorDeskRecord>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.name !== "string" || !record.name.trim()) return null;

  const now = nowIso();
  return {
    id: record.id.trim(),
    name: normalizeDirectorDeskName(record.name),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
  };
}

function dedupeRecords(records: DirectorDeskRecord[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

export function readDirectorDeskRecords() {
  const storage = getStorageSafe();
  if (!storage) return [];

  try {
    const raw = storage.getItem(DIRECTOR_DESK_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return dedupeRecords(parsed.map(normalizeRecord).filter((record): record is DirectorDeskRecord => Boolean(record)));
  } catch {
    return [];
  }
}

function hasDirectorDeskRegistry() {
  const storage = getStorageSafe();
  if (!storage) return false;
  try {
    return storage.getItem(DIRECTOR_DESK_REGISTRY_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeDirectorDeskRecords(records: DirectorDeskRecord[]) {
  const storage = getStorageSafe();
  if (!storage) return;

  try {
    storage.setItem(DIRECTOR_DESK_REGISTRY_KEY, JSON.stringify(dedupeRecords(records)));
  } catch {
    // Keep the editor usable if localStorage quota is exceeded.
  }
}

export function readActiveDirectorDeskId() {
  const storage = getStorageSafe();
  if (!storage) return null;
  try {
    const value = storage.getItem(ACTIVE_DIRECTOR_DESK_ID_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeActiveDirectorDeskId(id: string) {
  const storage = getStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_DIRECTOR_DESK_ID_KEY, id);
  } catch {
    // Keep the editor usable if localStorage is unavailable or full.
  }
}

function clearActiveDirectorDeskId() {
  const storage = getStorageSafe();
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_DIRECTOR_DESK_ID_KEY);
  } catch {
    // Keep the editor usable if localStorage is unavailable.
  }
}

function getNextDirectorDeskNumber(records: DirectorDeskRecord[]) {
  let max = 0;
  for (const record of records) {
    const idMatch = record.id.match(/^desk_(\d+)$/);
    const nameMatch = record.name.match(/^导演台\s*(\d+)\s*号$/);
    const idNumber = idMatch ? Number(idMatch[1]) : 0;
    const nameNumber = nameMatch ? Number(nameMatch[1]) : 0;
    max = Math.max(max, idNumber, nameNumber);
  }
  return max + 1;
}

function removeDirectorDeskScene(id: string) {
  const storage = getStorageSafe();
  if (!storage) return;

  try {
    storage.removeItem(`${LEGACY_DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${id}`);
    if (id === `${DIRECTOR_DESK_ID_PREFIX}1`) {
      storage.removeItem(LEGACY_DIRECTOR_SCENE_STORAGE_KEY);
    }
  } catch {
    // Keep the editor usable if localStorage is unavailable.
  }
}

export function createDirectorDeskRecord(records: DirectorDeskRecord[], name?: string) {
  const nextNumber = getNextDirectorDeskNumber(records);
  const timestamp = nowIso();
  return {
    id: `${DIRECTOR_DESK_ID_PREFIX}${nextNumber}`,
    name: name?.trim() || `导演台 ${nextNumber} 号`,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies DirectorDeskRecord;
}

export function ensureDirectorDeskRecords() {
  const records = readDirectorDeskRecords();
  if (records.length) return records;
  if (hasDirectorDeskRegistry()) return [];

  const first = createDirectorDeskRecord([], "导演台 1 号");
  const storage = getStorageSafe();
  const firstSceneKey = `${LEGACY_DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${first.id}`;
  const legacyScene = storage?.getItem(LEGACY_DIRECTOR_SCENE_STORAGE_KEY);
  if (storage && legacyScene && !storage.getItem(firstSceneKey)) {
    try {
      storage.setItem(firstSceneKey, legacyScene);
    } catch {
      // Ignore quota errors; a new empty first desk will still be created.
    }
  }
  writeDirectorDeskRecords([first]);
  writeActiveDirectorDeskId(first.id);
  return [first];
}

export function getInitialDirectorDeskId(records: DirectorDeskRecord[]) {
  try {
    const params = new URLSearchParams(window.location.search);
    const instanceId = params.get("instanceId")?.trim();
    if (instanceId) return instanceId;
  } catch {
    // Ignore malformed URL state.
  }

  const activeId = readActiveDirectorDeskId();
  if (activeId && records.some((record) => record.id === activeId)) return activeId;
  return records[0]?.id ?? null;
}

export function upsertDirectorDeskRecord(records: DirectorDeskRecord[], record: DirectorDeskRecord) {
  const exists = records.some((item) => item.id === record.id);
  if (exists) return records.map((item) => (item.id === record.id ? record : item));
  return [...records, record];
}

export function ensureDirectorDeskRecordForId(records: DirectorDeskRecord[], id: string) {
  const existing = records.find((record) => record.id === id);
  if (existing) return { records, record: existing };

  const timestamp = nowIso();
  const record: DirectorDeskRecord = {
    id,
    name: id.startsWith(DIRECTOR_DESK_ID_PREFIX) ? `导演台 ${id.slice(DIRECTOR_DESK_ID_PREFIX.length)} 号` : id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const nextRecords = upsertDirectorDeskRecord(records, record);
  writeDirectorDeskRecords(nextRecords);
  return { records: nextRecords, record };
}

export function touchDirectorDeskRecord(records: DirectorDeskRecord[], id: string) {
  const timestamp = nowIso();
  const nextRecords = records.map((record) =>
    record.id === id
      ? {
          ...record,
          updatedAt: timestamp,
        }
      : record
  );
  writeDirectorDeskRecords(nextRecords);
  return nextRecords;
}

export function deleteDirectorDeskRecord(records: DirectorDeskRecord[], id: string) {
  removeDirectorDeskScene(id);

  const nextRecords = dedupeRecords(records).filter((record) => record.id !== id);
  const currentActiveId = readActiveDirectorDeskId();
  const nextActiveId =
    currentActiveId && nextRecords.some((record) => record.id === currentActiveId)
      ? currentActiveId
      : (nextRecords[0]?.id ?? null);

  writeDirectorDeskRecords(nextRecords);
  if (nextActiveId) {
    writeActiveDirectorDeskId(nextActiveId);
  } else {
    clearActiveDirectorDeskId();
  }

  return {
    records: nextRecords,
    activeId: nextActiveId,
  };
}
