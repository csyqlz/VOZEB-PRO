import type { DirectorProject } from "../schema/directorProject";

export const DIRECTOR_PROJECT_DOCUMENT_FORMAT = "3d-director-desk-project";
export const DIRECTOR_PROJECT_SCHEMA_VERSION = 1;

export interface DirectorProjectDocument {
  format: typeof DIRECTOR_PROJECT_DOCUMENT_FORMAT;
  schemaVersion: typeof DIRECTOR_PROJECT_SCHEMA_VERSION;
  exportedAt: string;
  project: DirectorProject;
}

interface DirectorProjectDocumentEnvelope {
  format: typeof DIRECTOR_PROJECT_DOCUMENT_FORMAT;
  schemaVersion: number;
  exportedAt?: unknown;
  project: unknown;
}

type DirectorProjectDocumentMigration = (
  document: DirectorProjectDocumentEnvelope
) => DirectorProjectDocumentEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const DIRECTOR_PROJECT_DOCUMENT_MIGRATIONS: Readonly<
  Partial<Record<number, DirectorProjectDocumentMigration>>
> = {
  0: (document) => ({
    ...document,
    schemaVersion: 1,
  }),
};

export function isDirectorProjectShape(value: unknown): value is DirectorProject {
  if (!isRecord(value)) return false;
  return value.version === 1
    && isRecord(value.scene)
    && typeof value.scene.backgroundColor === "string"
    && Array.isArray(value.assets)
    && Array.isArray(value.objects)
    && Array.isArray(value.cameras);
}

export function createDirectorProjectDocument(
  project: DirectorProject,
  exportedAt = new Date().toISOString()
): DirectorProjectDocument {
  return {
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion: DIRECTOR_PROJECT_SCHEMA_VERSION,
    exportedAt,
    project,
  };
}

export function getDirectorProjectFingerprint(project: DirectorProject) {
  const text = JSON.stringify(project);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function migrateDirectorProjectDocument(value: unknown): DirectorProjectDocumentEnvelope {
  const source: DirectorProjectDocumentEnvelope = isDirectorProjectShape(value)
    ? {
        format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
        schemaVersion: 0,
        project: value,
      }
    : isRecord(value) && value.format === DIRECTOR_PROJECT_DOCUMENT_FORMAT
      ? (() => {
          if (typeof value.schemaVersion !== "number") {
            throw new Error(`不支持的工程数据版本：${String(value.schemaVersion)}`);
          }
          return {
            format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
            schemaVersion: value.schemaVersion,
            exportedAt: value.exportedAt,
            project: value.project,
          };
        })()
      : (() => {
          throw new Error("不是有效的 3D 导演台工程文件");
        })();

  if (!Number.isInteger(source.schemaVersion) || source.schemaVersion < 0) {
    throw new Error(`不支持的工程数据版本：${String(source.schemaVersion)}`);
  }
  if (source.schemaVersion > DIRECTOR_PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支持的工程数据版本：${String(source.schemaVersion)}`);
  }

  let migrated = cloneJson(source);
  while (migrated.schemaVersion < DIRECTOR_PROJECT_SCHEMA_VERSION) {
    const migrate = DIRECTOR_PROJECT_DOCUMENT_MIGRATIONS[migrated.schemaVersion];
    if (!migrate) {
      throw new Error(`缺少工程数据版本 ${migrated.schemaVersion} 的迁移程序`);
    }
    const previousVersion = migrated.schemaVersion;
    migrated = migrate(migrated);
    if (migrated.schemaVersion !== previousVersion + 1) {
      throw new Error(`工程数据版本 ${previousVersion} 的迁移程序无效`);
    }
  }
  return migrated;
}

export function parseDirectorProjectDocument(value: unknown): DirectorProject {
  const document = migrateDirectorProjectDocument(value);
  if (!isDirectorProjectShape(document.project)) {
    throw new Error("工程文件内容不完整或已经损坏");
  }
  return document.project;
}
