import { forwardRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { clearViewportCaptureHandler, requestViewportCapture } from "../../io/captureBridge";
import { getViewportAspectFrameRect } from "../viewportAspectFrame";

const mockCameraPositionSet = vi.hoisted(() => vi.fn());
const mockCameraLookAt = vi.hoisted(() => vi.fn());
const mockCameraUpdateMatrixWorld = vi.hoisted(() => vi.fn());
const mockCameraUpdateProjectionMatrix = vi.hoisted(() => vi.fn());
const mockCaptureExcludedObjects = vi.hoisted(() => [
  { name: "viewport-grid", userData: { hideFromViewportCapture: true }, visible: true },
  { name: "viewport-camera-wireframe", userData: { hideFromViewportCapture: true }, visible: true },
]);
const mockCaptureVisibleObject = vi.hoisted(() => ({
  name: "role-model",
  userData: {},
  visible: true,
}));
const mockRenderVisibilitySnapshots = vi.hoisted(() => [] as boolean[][]);

beforeEach(() => {
  window.history.replaceState({}, "", "/?instanceId=desk_1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  mockCameraPositionSet.mockClear();
  mockCameraLookAt.mockClear();
  mockCameraUpdateMatrixWorld.mockClear();
  mockCameraUpdateProjectionMatrix.mockClear();
  mockRenderVisibilitySnapshots.length = 0;
  mockCaptureExcludedObjects.forEach((object) => {
    object.visible = true;
  });
  mockCaptureVisibleObject.visible = true;
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    openScopedScene: vi.fn(),
  });
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
});

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");

  return {
    ...actual,
    Canvas: ({
      children,
      className,
      onPointerMissed,
    }: {
      children: React.ReactNode;
      className?: string;
      onPointerMissed?: () => void;
    }) => (
      <div className={className} data-testid="mock-r3f-canvas" onClick={() => onPointerMissed?.()}>
        {children}
      </div>
    ),
    useFrame: () => undefined,
    useThree: () => {
      const testCamera = new PerspectiveCamera(50, 1000 / 700, 0.1, 1000);
      testCamera.position.set(0, 2.2, 9);
      testCamera.lookAt(0, 1.2, 0);
      testCamera.updateProjectionMatrix();
      testCamera.updateMatrixWorld();
      const position = testCamera.position;
      const originalLookAt = testCamera.lookAt.bind(testCamera);
      const originalUpdateMatrixWorld = testCamera.updateMatrixWorld.bind(testCamera);
      const originalUpdateProjectionMatrix = testCamera.updateProjectionMatrix.bind(testCamera);
      const originalPositionSet = position.set.bind(position);
      const originalPositionCopy = position.copy.bind(position);
      position.set = ((x: number, y: number, z: number) => {
        mockCameraPositionSet(x, y, z);
        const result = originalPositionSet(x, y, z);
        testCamera.updateMatrixWorld();
        return result;
      }) as typeof position.set;
      position.copy = ((vector: Vector3) => {
        const result = originalPositionCopy(vector);
        testCamera.updateMatrixWorld();
        return result;
      }) as typeof position.copy;

      const lookAt = (...args: Parameters<PerspectiveCamera["lookAt"]>) => {
        mockCameraLookAt(...args);
        const result = originalLookAt(...args);
        originalUpdateMatrixWorld();
        return result;
      };
      const updateMatrixWorld = (...args: Parameters<PerspectiveCamera["updateMatrixWorld"]>) => {
        mockCameraUpdateMatrixWorld(...args);
        return originalUpdateMatrixWorld(...args);
      };
      const updateProjectionMatrix = () => {
        mockCameraUpdateProjectionMatrix();
        return originalUpdateProjectionMatrix();
      };

      testCamera.lookAt = lookAt as PerspectiveCamera["lookAt"];
      testCamera.updateMatrixWorld = updateMatrixWorld as PerspectiveCamera["updateMatrixWorld"];
      testCamera.updateProjectionMatrix = updateProjectionMatrix as PerspectiveCamera["updateProjectionMatrix"];

      return {
        camera: testCamera,
        gl: {
          render: () => {
            mockRenderVisibilitySnapshots.push([
              ...mockCaptureExcludedObjects.map((object) => object.visible),
              mockCaptureVisibleObject.visible,
            ]);
          },
          setClearColor: () => undefined,
          domElement: {
            width: 1000,
            height: 700,
            clientWidth: 1000,
            clientHeight: 700,
            toDataURL: () => "data:image/png;base64,mock",
          },
        },
        scene: {
          background: null,
          backgroundRotation: {
            clone: () => ({
              copy: () => undefined,
            }),
            copy: () => undefined,
            set: () => undefined,
          },
          backgroundBlurriness: 0,
          backgroundIntensity: 1,
          traverse: (callback: (object: { userData?: Record<string, unknown>; visible: boolean }) => void) => {
            [...mockCaptureExcludedObjects, mockCaptureVisibleObject].forEach(callback);
          },
        },
      };
    },
  };
});

vi.mock("@react-three/drei", async () => {
  const actual = await vi.importActual<typeof import("@react-three/drei")>("@react-three/drei");

  return {
    ...actual,
    Grid: ({
      cellColor,
      cellThickness,
      fadeDistance,
      infiniteGrid,
      position,
      sectionColor,
    }: {
      cellColor?: string;
      cellThickness?: number;
      fadeDistance?: number;
      infiniteGrid?: boolean;
      position?: [number, number, number];
      sectionColor?: string;
    }) => (
      <div
        data-cell-color={cellColor}
        data-cell-thickness={String(cellThickness)}
        data-fade-distance={String(fadeDistance)}
        data-infinite-grid={String(infiniteGrid)}
        data-position={JSON.stringify(position)}
        data-section-color={sectionColor}
        data-testid="viewport-grid"
      />
    ),
    GizmoHelper: ({
      alignment,
      children,
      margin,
    }: {
      alignment?: string;
      children?: React.ReactNode;
      margin?: [number, number];
    }) => (
      <div data-alignment={alignment} data-margin={JSON.stringify(margin)} data-testid="native-gizmo-helper">
        {children}
      </div>
    ),
    GizmoViewport: ({
      axisColors,
      disabled,
      scale,
    }: {
      axisColors?: [string, string, string];
      disabled?: boolean;
      scale?: number;
    }) => (
      <button
        data-axis-colors={JSON.stringify(axisColors)}
        data-disabled={String(disabled)}
        data-scale={String(scale)}
        data-testid="native-gizmo-viewport"
        type="button"
      />
    ),
    OrbitControls: forwardRef(({
      enabled,
      rotateSpeed,
      zoomSpeed,
    }: {
      enabled?: boolean;
      rotateSpeed?: number;
      zoomSpeed?: number;
    }) => (
      <div
        data-enabled={String(enabled)}
        data-rotate-speed={String(rotateSpeed)}
        data-zoom-speed={String(zoomSpeed)}
        data-testid="orbit-controls"
      />
    )),
    PerspectiveCamera: () => null,
    Html: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Line: () => null,
    useTexture: () => ({ isTexture: true }),
  };
});

vi.mock("../SceneRoot", () => ({
  SceneRoot: () => null,
}));

vi.mock("../ViewportBackground", () => ({
  ViewportBackground: ({ panoramaAsset }: { panoramaAsset?: { id: string } | null }) => (
    <div data-panorama-asset-id={panoramaAsset?.id ?? "none"} data-testid="viewport-background" />
  ),
}));

import App from "../../../App";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";

it("renders a live R3F viewport and director scene controls", () => {
  render(<App />);

  expect(screen.getByTestId("director-canvas")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "人物和道具动作播放条" })).toBeInTheDocument();
  expect(screen.getByLabelText("场景缩放")).toBeInTheDocument();
  expect(screen.getByText("背景")).toBeInTheDocument();
  expect(screen.getByLabelText("天空颜色 HEX")).toBeInTheDocument();
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "true");
});

it("passes the active panorama to the interactive viewport", () => {
  useDirectorStore.getState().setPanoramaAsset({
    name: "测试全景",
    fileName: "panorama.jpg",
    url: "data:image/jpeg;base64,panorama",
    projectionMode: "equirectangular",
  });
  const panoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;

  render(<App />);

  expect(screen.getByTestId("viewport-background")).toHaveAttribute(
    "data-panorama-asset-id",
    panoramaAssetId
  );
});

it("keeps orbit controls available when a transformable object is selected but no handle is being dragged", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-enabled", "true");
});

it("applies the user-adjusted rotate and zoom sensitivity to orbit controls", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportRotateSensitivity: 0.8,
    viewportZoomSensitivity: 0.65,
  });

  render(<App />);

  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-rotate-speed", "0.8");
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-zoom-speed", "0.65");
});

it("applies sensitivity changes from the visible settings panel to orbit controls immediately", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "视角手感" }));
  fireEvent.change(screen.getByRole("slider", { name: "转动视角灵敏度" }), {
    target: { value: "125" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "缩放视角灵敏度" }), {
    target: { value: "110" },
  });

  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-rotate-speed", "1.25");
  expect(screen.getByTestId("orbit-controls")).toHaveAttribute("data-zoom-speed", "1.1");
});

it("does not render a full-viewport transform drag layer over the 3D viewport", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.queryByRole("application", { name: "3D视口移动拖拽层" })).not.toBeInTheDocument();
  expect(screen.queryByRole("application", { name: "3D视口旋转拖拽层" })).not.toBeInTheDocument();
  expect(screen.queryByRole("application", { name: "3D视口缩放拖拽层" })).not.toBeInTheDocument();
});

it("renders only the dark major viewport grid lines", () => {
  render(<App />);

  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-cell-thickness", "0");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-position", "[0,0.002,0]");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-section-color", "#2A4065");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-fade-distance", "80");
  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-infinite-grid", "true");
});

it("hides only the editing grid when its independent switch is disabled", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      scene: {
        ...state.project.scene,
        showGrid: false,
        snapToGrid: true,
        showGround: true,
        pathCollisionEnabled: true,
      },
    },
  });

  render(<App />);

  expect(screen.queryByTestId("viewport-grid")).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.scene).toMatchObject({
    snapToGrid: true,
    showGround: true,
    pathCollisionEnabled: true,
  });
});

it("keeps the viewport grid slightly above the configured ground plane", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        groundHeight: 1.5,
      },
    },
  });

  render(<App />);

  expect(screen.getByTestId("viewport-grid")).toHaveAttribute("data-position", "[0,1.502,0]");
});

it("opens the scene inspector when users click empty 3D viewport space", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<App />);

  expect(screen.getByLabelText("角色名称")).toBeInTheDocument();

  fireEvent.click(within(screen.getByTestId("director-canvas")).getByTestId("mock-r3f-canvas"));

  expect(useDirectorStore.getState().selectedObjectId).toBeNull();
  expect(screen.getByLabelText("3D场景右侧属性面板")).toBeInTheDocument();
  expect(screen.getByLabelText("场景缩放")).toBeInTheDocument();
});

it("renders the viewport aspect ratio overlay when a non-auto frame is selected", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "9:16",
  });

  render(<App />);

  expect(screen.getByLabelText("视口画幅框")).toBeInTheDocument();
  expect(screen.getAllByLabelText("视口画幅遮罩")).toHaveLength(1);
  expect(screen.getByLabelText("视口画幅框")).toHaveAttribute("data-aspect-ratio", "9:16");
});

it("toggles the viewport rule-of-thirds guide from the aspect frame button", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
    viewportRuleOfThirdsEnabled: false,
  });

  render(<App />);

  const guideToggle = screen.getByRole("button", { name: "开启九宫格辅助线" });
  fireEvent.click(guideToggle);

  expect(useDirectorStore.getState().viewportRuleOfThirdsEnabled).toBe(true);
  expect(screen.getByLabelText("九宫格辅助线")).toBeInTheDocument();
});

it("renders the native 3D viewport gizmo in an overlay canvas above the aspect mask", () => {
  render(<App />);

  expect(screen.getAllByTestId("mock-r3f-canvas")).toHaveLength(2);
  expect(screen.getByLabelText("3D视口原生坐标控件")).toContainElement(screen.getByTestId("native-gizmo-helper"));
  expect(screen.getByTestId("native-gizmo-helper")).toHaveAttribute("data-alignment", "center-center");
  expect(screen.getByTestId("native-gizmo-helper")).toHaveAttribute("data-margin", "[0,0]");
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute(
    "data-axis-colors",
    "[\"#E56C5B\",\"#6CDB7A\",\"#7AA7FF\"]"
  );
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute("data-disabled", "true");
  expect(screen.getByTestId("native-gizmo-viewport")).toHaveAttribute("data-scale", "25");
  expect(screen.getByTestId("native-gizmo-viewport").closest(".director-canvas")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("3D视口坐标指示")).not.toBeInTheDocument();
});

it("offsets the native viewport gizmo inward when overlay side panels are open", () => {
  render(<App />);

  const gizmo = screen.getByLabelText("3D视口原生坐标控件");

  expect(gizmo).toHaveStyle({
    right: "296px",
  });
});

it("syncs native viewport gizmo axis clicks back to the main director view", () => {
  render(<App />);
  mockCameraPositionSet.mockClear();

  const xAxisHitTarget = screen.getByRole("button", { name: "切换到 X 正向视图" });
  expect(xAxisHitTarget).toHaveClass("viewport-gizmo-hit-button");

  fireEvent.click(xAxisHitTarget);

  expect(mockCameraPositionSet).toHaveBeenCalledWith(expect.closeTo(5.423099, 5), 1.05, 0);
});

it("captures screenshots using the selected viewport aspect ratio crop", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "9:16",
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(results[0]?.dataUrl).toBe("data:image/png;base64,cropped");
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(cropCanvas.width / cropCanvas.height).toBeCloseTo(9 / 16, 2);
});

it("draws visible character name labels into viewport screenshots", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,labelled"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(fillText).toHaveBeenCalledWith("角色01", expect.any(Number), expect.any(Number));
});

it("does not draw character name labels into screenshots when scene labels are hidden", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    project: {
      ...useDirectorStore.getState().project,
      scene: {
        ...useDirectorStore.getState().project.scene,
        showLabels: false,
      },
    },
    viewportAspectRatio: "16:9",
  });

  const originalCreateElement = document.createElement.bind(document);
  const fillText = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillText,
      measureText: vi.fn(() => ({ width: 32 })),
      quadraticCurveTo: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    })),
    toDataURL: vi.fn(() => "data:image/png;base64-unlabelled"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(fillText).not.toHaveBeenCalled();
});

it("hides viewport grid and camera helper models only while rendering screenshots", async () => {
  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(mockRenderVisibilitySnapshots).toContainEqual([false, false, true]);
  expect(mockCaptureExcludedObjects.map((object) => object.visible)).toEqual([true, true]);
  expect(mockCaptureVisibleObject.visible).toBe(true);
});

it("captures screenshots from the same safe-area frame shown by the aspect overlay", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "16:9",
    viewportPanelsCollapsed: false,
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped-safe-area"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  const expectedFrame = getViewportAspectFrameRect("16:9", 1000, 700, 124, {
    left: 196,
    right: 276,
    top: 0,
    bottom: 0,
  });

  expect(expectedFrame).not.toBeNull();
  expect(drawImage).toHaveBeenCalledWith(
    expect.anything(),
    Math.round(expectedFrame!.left),
    Math.round(expectedFrame!.top),
    Math.round(expectedFrame!.width),
    Math.round(expectedFrame!.height),
    0,
    0,
    Math.round(expectedFrame!.width),
    Math.round(expectedFrame!.height)
  );
});

it("captures every four-view screenshot using the selected viewport aspect ratio crop", async () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewportAspectRatio: "4:3",
  });

  const originalCreateElement = document.createElement.bind(document);
  const drawImage = vi.fn();
  const cropCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage,
    })),
    toDataURL: vi.fn(() => "data:image/png;base64,cropped-four"),
  };

  vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName === "canvas") {
      return cropCanvas as unknown as HTMLCanvasElement;
    }

    return originalCreateElement(tagName);
  }) as typeof document.createElement);

  render(<App />);

  const results = await requestViewportCapture({
    preset: "four",
    source: "capture-panel",
  });

  expect(results).toHaveLength(4);
  results.forEach((result) => {
    expect(result.dataUrl).toBe("data:image/png;base64,cropped-four");
  });
  expect(drawImage).toHaveBeenCalledTimes(4);
  expect(cropCanvas.width / cropCanvas.height).toBeCloseTo(4 / 3, 2);
});

it("synchronizes the real render camera on every first-person motion preview update", () => {
  const state = useDirectorStore.getState();
  const firstCharacter = state.project.objects.find((item) => item.id === "char_default_a")!;
  const secondCharacter = {
    ...firstCharacter,
    id: "char_second",
    name: "角色02",
    transform: {
      ...firstCharacter.transform,
      position: [4, 0, 0] as [number, number, number],
    },
  };
  useDirectorStore.setState({
    ...state,
    viewMode: "camera",
    cameraMotionProgress: 0.5,
    cameraMotionPlaying: true,
    motionStudioOpen: true,
    project: {
      ...state.project,
      objects: [...state.project.objects, secondCharacter],
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "linear" as const,
          easing: "linear" as const,
          keyframes: [
            { id: "point_1", time: 0, position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50, targetMode: "object" as const, targetObjectId: "char_default_a" },
            { id: "point_2", time: 1, position: [4, 2, 4] as [number, number, number], target: [4, 1, 0] as [number, number, number], fov: 40, targetMode: "object" as const, targetObjectId: "char_second" },
          ],
        },
      })),
    },
  });

  render(<App />);

  expect(mockCameraPositionSet).toHaveBeenCalledWith(2, 2, 6);
  expect(mockCameraLookAt).toHaveBeenCalledWith(2, expect.any(Number), 0);
  expect(mockCameraUpdateProjectionMatrix).toHaveBeenCalled();
});

it("keeps the bottom timeline available in finished-shot view and pauses when scrubbing", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewMode: "camera",
    cameraMotionProgress: 0.25,
    cameraMotionPlaying: true,
    motionStudioOpen: true,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "linear" as const,
          easing: "linear" as const,
          keyframes: [
            { id: "preview_1", time: 0, position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 },
            { id: "preview_2", time: 1, position: [4, 2, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 45 },
          ],
        },
      })),
    },
  });

  render(<App />);

  const timeline = screen.getByRole("slider", { name: "场景动作时间轴" });
  expect(timeline).toHaveValue("0.25");
  expect(screen.queryByRole("group", { name: "3D视口快捷工具" })).not.toBeInTheDocument();
  fireEvent.change(timeline, { target: { value: "0.6" } });
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.6);
  expect(useDirectorStore.getState().viewMode).toBe("camera");
  expect(document.querySelector(".director-shell")).toHaveClass("is-camera-previewing");
  expect(screen.queryByRole("group", { name: "3D视口快捷工具" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("路线实时监看")).toBeInTheDocument();
});

it("keeps the finished-shot monitor mounted while paused for timeline scrubbing", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    motionStudioOpen: true,
    cameraMotionPlaying: false,
    cameraMotionProgress: 0.5,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "linear" as const,
          easing: "linear" as const,
          keyframes: [
            { id: "monitor_1", time: 0, position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 },
            { id: "monitor_2", time: 1, position: [4, 2, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 42 },
          ],
        },
      })),
    },
  });

  render(<App />);

  expect(screen.getByLabelText("成片实时监看")).toBeInTheDocument();
  expect(screen.getByLabelText("拖动监看窗口")).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "看成片 FOV" })).toHaveValue("46");
  expect(screen.getByRole("slider", { name: "小窗 FOV" })).toHaveValue("46");
});

it("passes the active panorama to both the main viewport and finished-shot monitor", () => {
  const state = useDirectorStore.getState();
  const panoramaAsset = {
    id: "panorama_monitor",
    kind: "panorama" as const,
    sourceType: "image" as const,
    fileName: "monitor.jpg",
    name: "监看全景",
    url: "data:image/jpeg;base64,panorama",
    projectionMode: "equirectangular" as const,
  };
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    motionStudioOpen: true,
    project: {
      ...state.project,
      assets: [...state.project.assets, panoramaAsset],
      panoramaAssetId: panoramaAsset.id,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "linear" as const,
          easing: "linear" as const,
          keyframes: [
            { id: "panorama_1", time: 0, position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 },
            { id: "panorama_2", time: 1, position: [4, 2, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 42 },
          ],
        },
      })),
    },
  });

  render(<App />);

  const backgrounds = screen.getAllByTestId("viewport-background");
  expect(backgrounds).toHaveLength(2);
  backgrounds.forEach((background) => {
    expect(background).toHaveAttribute("data-panorama-asset-id", panoramaAsset.id);
  });
});

it("keeps finished-shot and monitor FOV controls independent", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    motionStudioOpen: true,
    finishedShotFov: 36,
    motionMonitorFov: 72,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "linear" as const,
          easing: "linear" as const,
          keyframes: [
            { id: "fov_1", time: 0, position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 },
            { id: "fov_2", time: 1, position: [4, 2, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 42 },
          ],
        },
      })),
    },
  });

  render(<App />);

  const finishedSlider = screen.getByRole("slider", { name: "看成片 FOV" });
  const monitorSlider = screen.getByRole("slider", { name: "小窗 FOV" });
  expect(finishedSlider).toHaveValue("36");
  expect(monitorSlider).toHaveValue("72");

  fireEvent.change(monitorSlider, { target: { value: "80" } });
  expect(useDirectorStore.getState().motionMonitorFov).toBe(80);
  expect(useDirectorStore.getState().finishedShotFov).toBe(36);

  fireEvent.change(finishedSlider, { target: { value: "40" } });
  expect(useDirectorStore.getState().finishedShotFov).toBe(40);
  expect(useDirectorStore.getState().motionMonitorFov).toBe(80);
});

it("adds a new waypoint for every Enter press while character action playback is paused", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    cameraPilotMode: "pilot",
    cameraMotionPlaying: false,
    cameraMotionProgress: 0.5,
    motionStudioOpen: true,
    project: {
      ...state.project,
      objects: state.project.objects.map((object) => object.id === "char_default_a" ? {
        ...object,
        motionPath: {
          interpolation: "linear" as const,
          keyframes: [
            { id: "action_1", time: 0, transform: object.transform },
            { id: "action_2", time: 1, transform: { ...object.transform, position: [4, 0, 0] as [number, number, number] } },
          ],
        },
      } : object),
    },
  });

  render(<App />);
  fireEvent.keyDown(window, { code: "Enter", repeat: false });
  fireEvent.keyDown(window, { code: "Enter", repeat: false });
  fireEvent.keyDown(window, { code: "Enter", repeat: false });

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toHaveLength(3);
});
