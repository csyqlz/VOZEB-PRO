import type { DirectorProject } from "../schema/directorProject";
import { createDirectorProjectDocument } from "./projectDocument";

export function serializeProject(project: DirectorProject) {
  return JSON.stringify(createDirectorProjectDocument(project), null, 2);
}
