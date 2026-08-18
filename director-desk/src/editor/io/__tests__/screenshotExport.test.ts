import { parseProject } from "../importProjectJson";
import { buildScreenshotMeta } from "../screenshotExport";
import { serializeProject } from "../exportProjectJson";
import { createDefaultDirectorProject } from "../../store/directorStore";

it("captures the required metadata for camera-mode screenshots", () => {
  expect(
    buildScreenshotMeta({
      mode: "camera",
      cameraId: "cam_1",
      fov: 50,
      position: [0, 2.2, 9],
      target: [0, 1.2, 0],
    })
  ).toEqual({
    mode: "camera",
    cameraId: "cam_1",
    fov: 50,
    position: [0, 2.2, 9],
    target: [0, 1.2, 0],
  });
});

it("round-trips the project JSON without losing objects or cameras", () => {
  const json = serializeProject(createDefaultDirectorProject());
  const project = parseProject(json);

  expect(project.cameras[0].name).toBe("机位01");
  expect(project.objects.some((item) => item.kind === "character")).toBe(true);
});
