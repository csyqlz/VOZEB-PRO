import { expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../store/directorStore";
import { setRuntimePlaybackProgress } from "../../runtime/playbackRuntime";
import {
  DIRECTOR_EXTENSION_ACTIONS,
  createDirectorExtensionCapabilities,
  createDirectorExtensionProjectSnapshot,
  createDirectorExtensionTimelineSnapshot,
  parseDirectorExtensionRequest,
} from "../extensionProtocol";

it("publishes the first read-only protocol capabilities", () => {
  expect(createDirectorExtensionCapabilities()).toEqual({
    protocolVersion: 1,
    projectSchemaVersion: 1,
    actions: [
      "capabilities.get",
      "project.get",
      "timeline.get",
      "export.frame",
      "export.video",
      "plugin.result.submit",
      "plugin.results.list",
    ],
    uiExports: ["project-json", "reference-video", "viewport-still"],
    protocolExports: ["clean-frame", "reference-video"],
    assetPersistence: "browser-local-references",
  });
  expect(DIRECTOR_EXTENSION_ACTIONS).toHaveLength(7);
});

it("only accepts known actions with a bounded request id", () => {
  expect(parseDirectorExtensionRequest({ requestId: " request-1 ", action: "project.get" })).toEqual({
    requestId: "request-1",
    action: "project.get",
  });
  expect(parseDirectorExtensionRequest({ requestId: "request-2", action: "project.delete" })).toBeNull();
  expect(parseDirectorExtensionRequest({ requestId: "", action: "timeline.get" })).toBeNull();
});

it("normalizes frame and video export options", () => {
  expect(parseDirectorExtensionRequest({
    requestId: "frame-request",
    action: "export.frame",
    options: { fileName: " 首帧.png ", position: "first", quality: "1080p" },
  })).toEqual({
    requestId: "frame-request",
    action: "export.frame",
    options: { fileName: "首帧.png", position: "first", quality: "1080p" },
  });
  expect(parseDirectorExtensionRequest({
    requestId: "video-request",
    action: "export.video",
    options: { fps: 27, quality: "bad" },
  })).toEqual({
    requestId: "video-request",
    action: "export.video",
    options: { fileName: "director-reference.mp4", fps: 30, quality: "720p" },
  });
});

it("preserves a plugin result payload for dedicated validation", () => {
  const result = { plugin: { id: "demo", name: "Demo", version: "1" } };
  expect(parseDirectorExtensionRequest({
    requestId: "plugin-request",
    action: "plugin.result.submit",
    options: { result },
  })).toEqual({
    requestId: "plugin-request",
    action: "plugin.result.submit",
    options: { result },
  });
});

it("returns a detached project snapshot and marks browser-local assets", () => {
  const project = createDefaultDirectorProject();
  project.assets.push({
    id: "local-character",
    kind: "character",
    sourceType: "model",
    fileName: "person.glb",
    url: "blob:http://localhost/person",
    storageKey: "asset-person",
  });
  const snapshot = createDirectorExtensionProjectSnapshot(project);
  snapshot.project.scene.backgroundColor = "#ffffff";

  expect(project.scene.backgroundColor).not.toBe("#ffffff");
  expect(snapshot.portability).toMatchObject({ portable: false, browserLocalAssetIds: ["local-character"] });
  expect(snapshot.projectFingerprint).toMatch(/^fnv1a32-[0-9a-f]{8}$/);
});

it("marks browser-local animation assets as non-portable", () => {
  const project = createDefaultDirectorProject();
  project.animationAssets = [{
    id: "local-animation",
    name: "本地走路动作",
    fileName: "walk.fbx",
    url: "blob:http://localhost/walk",
    modelFormat: "fbx",
    storageKey: "animation-walk",
    rigProfile: "mixamo",
    clips: [{ id: "walk", name: "Walk", duration: 2, trackCount: 42 }],
  }];

  expect(createDirectorExtensionProjectSnapshot(project).portability).toMatchObject({
    portable: false,
    browserLocalAssetIds: ["local-animation"],
  });
});

it("preserves camera tracking, FOV, character routes, holds and actions in project snapshots", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((object) => object.kind === "character")!;
  character.motionPath = {
    interpolation: "smooth",
    speedMode: "custom",
    customEasing: [0.2, 0.1, 0.8, 0.9],
    keyframes: [
      {
        id: "character-point-1",
        time: 0,
        transform: structuredClone(character.transform),
        actionPresetId: "walk",
        facingMode: "path",
        pointBehavior: "hold",
        holdSeconds: 1.25,
        holdAction: "custom",
        holdActionPresetId: "wave",
      },
    ],
  };
  project.cameras[0].motionPath = {
    duration: 12,
    loop: false,
    interpolation: "smooth",
    easing: "ease-in-out",
    speedMode: "uniform",
    keyframes: [
      {
        id: "camera-point-1",
        time: 0,
        position: [1, 2, 3],
        target: [0, 1, 0],
        fov: 68,
        targetMode: "object",
        targetObjectId: character.id,
        targetBodyPart: "head",
        targetFollowMode: "smooth",
        pointBehavior: "hold",
        holdSeconds: 0.75,
      },
    ],
  };

  const snapshot = createDirectorExtensionProjectSnapshot(project);

  expect(snapshot.project.cameras[0].motionPath).toMatchObject({
    duration: 12,
    speedMode: "uniform",
    keyframes: [expect.objectContaining({
      fov: 68,
      targetMode: "object",
      targetObjectId: character.id,
      targetBodyPart: "head",
      targetFollowMode: "smooth",
      pointBehavior: "hold",
      holdSeconds: 0.75,
    })],
  });
  expect(snapshot.project.objects.find((object) => object.id === character.id)?.motionPath).toMatchObject({
    interpolation: "smooth",
    speedMode: "custom",
    customEasing: [0.2, 0.1, 0.8, 0.9],
    keyframes: [expect.objectContaining({
      actionPresetId: "walk",
      facingMode: "path",
      pointBehavior: "hold",
      holdSeconds: 1.25,
      holdAction: "custom",
      holdActionPresetId: "wave",
    })],
  });
});

it("reads the high-frequency runtime timeline instead of stale UI progress", () => {
  const project = createDefaultDirectorProject();
  project.cameras[0].motionPath = { ...project.cameras[0].motionPath!, duration: 8 };
  setRuntimePlaybackProgress(0.375);

  expect(createDirectorExtensionTimelineSnapshot({
    project,
    cameraMotionPlaying: true,
    viewMode: "camera",
  })).toEqual({
    protocolVersion: 1,
    progress: 0.375,
    timeSeconds: 3,
    durationSeconds: 8,
    playing: true,
    viewMode: "camera",
    activeCameraId: "cam_1",
  });
});

it("falls back to the first camera when the active camera id is invalid", () => {
  const project = createDefaultDirectorProject();
  project.activeCameraId = "missing-camera";
  project.cameras[0].motionPath = { ...project.cameras[0].motionPath!, duration: 9 };
  setRuntimePlaybackProgress(0.5);

  expect(createDirectorExtensionTimelineSnapshot({
    project,
    cameraMotionPlaying: false,
    viewMode: "director",
  })).toMatchObject({
    activeCameraId: "cam_1",
    durationSeconds: 9,
    progress: 0.5,
    timeSeconds: 4.5,
  });
});
