import { expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../store/directorStore";
import { serializeProject } from "../exportProjectJson";
import { parseProject } from "../importProjectJson";
import {
  DIRECTOR_PROJECT_DOCUMENT_FORMAT,
  DIRECTOR_PROJECT_SCHEMA_VERSION,
  getDirectorProjectFingerprint,
  migrateDirectorProjectDocument,
} from "../projectDocument";

it("wraps exported projects in a versioned document", () => {
  const parsed = JSON.parse(serializeProject(createDefaultDirectorProject()));
  expect(parsed).toMatchObject({
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion: DIRECTOR_PROJECT_SCHEMA_VERSION,
    project: { version: 1 },
  });
  expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
});

it("keeps importing legacy bare project JSON", () => {
  const project = createDefaultDirectorProject();
  expect(parseProject(JSON.stringify(project))).toEqual(project);
});

it("migrates a legacy bare project through the version pipeline without mutating it", () => {
  const project = createDefaultDirectorProject();
  const original = structuredClone(project);

  expect(migrateDirectorProjectDocument(project)).toMatchObject({
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion: DIRECTOR_PROJECT_SCHEMA_VERSION,
    project: original,
  });
  expect(project).toEqual(original);
});

it("accepts the explicit legacy document envelope through the same migration", () => {
  const project = createDefaultDirectorProject();
  expect(parseProject(JSON.stringify({
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion: 0,
    project,
  }))).toEqual(project);
});

it("rejects unknown future document versions instead of silently corrupting data", () => {
  expect(() => parseProject(JSON.stringify({
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion: 999,
    project: createDefaultDirectorProject(),
  }))).toThrow("不支持的工程数据版本：999");
});

it.each(["1", null, undefined])("rejects non-numeric document version %s", (schemaVersion) => {
  expect(() => parseProject(JSON.stringify({
    format: DIRECTOR_PROJECT_DOCUMENT_FORMAT,
    schemaVersion,
    project: createDefaultDirectorProject(),
  }))).toThrow("不支持的工程数据版本");
});

it("rejects arbitrary JSON that is not a director project", () => {
  expect(() => parseProject('{"hello":"world"}')).toThrow("不是有效的 3D 导演台工程文件");
});

it("creates a deterministic fingerprint that changes with project data", () => {
  const project = createDefaultDirectorProject();
  const original = getDirectorProjectFingerprint(project);
  expect(getDirectorProjectFingerprint(structuredClone(project))).toBe(original);
  project.cameras[0].fov = 72;
  expect(getDirectorProjectFingerprint(project)).not.toBe(original);
});
