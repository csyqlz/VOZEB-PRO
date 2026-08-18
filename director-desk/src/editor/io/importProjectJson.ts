import type { DirectorProject } from "../schema/directorProject";
import { parseDirectorProjectDocument } from "./projectDocument";

export function parseProject(json: string): DirectorProject {
  return parseDirectorProjectDocument(JSON.parse(json) as unknown);
}
