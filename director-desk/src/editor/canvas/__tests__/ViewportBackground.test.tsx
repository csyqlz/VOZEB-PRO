import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClampToEdgeWrapping, Color, EquirectangularReflectionMapping, Euler, SRGBColorSpace, Texture } from "three";
import type { DirectorAssetRef } from "../../schema/directorProject";

const loaderCalls: Array<{
  url: string;
  texture: Texture;
  onLoad: (texture: Texture) => void;
  onError?: (error: unknown) => void;
}> = [];
let synchronousLoaderError: Error | null = null;

const mockScene = {
  background: null as unknown,
  backgroundRotation: new Euler(),
  backgroundBlurriness: 0.25,
  backgroundIntensity: 0.4,
};
const mockGl = {
  setClearColor: vi.fn(),
};

vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");

  return {
    ...actual,
    TextureLoader: class {
      load(
        url: string,
        onLoad: (texture: Texture) => void,
        _onProgress?: unknown,
        onError?: (error: unknown) => void
      ) {
        if (synchronousLoaderError) throw synchronousLoaderError;
        const texture = new actual.Texture();
        loaderCalls.push({ url, texture, onLoad: onLoad as (texture: Texture) => void, onError });
        return texture;
      }
    },
  };
});

vi.mock("@react-three/fiber", () => ({
  useFrame: vi.fn(),
  useThree: () => ({
    camera: { position: { copy: vi.fn() } },
    gl: mockGl,
    scene: mockScene,
  }),
}));

vi.mock("@react-three/drei", () => ({
  Html: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { useFrame } from "@react-three/fiber";
import { ViewportBackground } from "../ViewportBackground";

const panoramaAsset: DirectorAssetRef = {
  id: "asset_panorama_1",
  kind: "panorama",
  sourceType: "image",
  fileName: "studio-panorama.jpg",
  url: "data:image/jpeg;base64,studio",
  projectionMode: "equirectangular",
};

const backdropAsset: DirectorAssetRef = {
  ...panoramaAsset,
  id: "asset_backdrop_1",
  fileName: "regular-photo.jpg",
  projectionMode: "backdrop",
};

beforeEach(() => {
  loaderCalls.length = 0;
  mockScene.background = null;
  mockScene.backgroundRotation.set(0, 0, 0);
  mockScene.backgroundBlurriness = 0.25;
  mockScene.backgroundIntensity = 0.4;
  mockGl.setClearColor.mockClear();
  synchronousLoaderError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("sets true 2:1 panorama textures as the 3D viewport equirectangular background", async () => {
  const { container } = render(
    <ViewportBackground
      backgroundColor="#06080D"
      panoramaAsset={panoramaAsset}
      panoramaRadius={60}
      panoramaYaw={30}
    />
  );

  expect(loaderCalls[0]?.url).toBe(panoramaAsset.url);
  expect(mockScene.background).toBeInstanceOf(Color);

  act(() => {
    loaderCalls[0]?.onLoad(loaderCalls[0].texture);
  });

  await waitFor(() => expect(mockScene.background).toBe(loaderCalls[0]?.texture));
  expect(loaderCalls[0]?.texture.colorSpace).toBe(SRGBColorSpace);
  expect(loaderCalls[0]?.texture.mapping).toBe(EquirectangularReflectionMapping);
  expect(mockScene.backgroundRotation.y).toBeCloseTo((120 * Math.PI) / 180);
  expect(container.querySelector('mesh[name="panorama-backdrop-dome"]')).not.toBeInTheDocument();
  expect(container.querySelector("mesh[data-testid]")).not.toBeInTheDocument();
});

it("renders regular uploaded photos on a scalable sphere with seam-safe edge handling", async () => {
  const { container, rerender } = render(
    <ViewportBackground
      backgroundColor="#06080D"
      panoramaAsset={backdropAsset}
      panoramaRadius={60}
      panoramaYaw={30}
    />
  );

  act(() => {
    loaderCalls[0]?.onLoad(loaderCalls[0].texture);
  });

  await waitFor(() => expect(container.querySelector('mesh[name="panorama-backdrop-dome"]')).toBeInTheDocument());
  expect(mockScene.background).toBeInstanceOf(Color);
  expect(mockScene.background).not.toBe(loaderCalls[0]?.texture);
  expect(loaderCalls[0]?.texture.mapping).not.toBe(EquirectangularReflectionMapping);
  expect(loaderCalls[0]?.texture.wrapS).toBe(ClampToEdgeWrapping);
  expect(loaderCalls[0]?.texture.wrapT).toBe(ClampToEdgeWrapping);
  expect(loaderCalls[0]?.texture.repeat.x).toBe(-1);
  expect(loaderCalls[0]?.texture.offset.x).toBe(1);
  expect(useFrame).not.toHaveBeenCalled();
  expect(container.querySelector("spheregeometry")).toHaveAttribute("args", "60,96,64");

  const backdropMesh = container.querySelector('mesh[name="panorama-backdrop-dome"]');
  expect(backdropMesh).not.toHaveAttribute("scale", "60,60,60");

  rerender(
    <ViewportBackground
      backgroundColor="#06080D"
      panoramaAsset={backdropAsset}
      panoramaRadius={150}
      panoramaYaw={30}
    />
  );

  expect(container.querySelector("spheregeometry")).toHaveAttribute("args", "150,96,64");
});

it("shows a visible viewport message instead of silently blacking out when panorama loading fails", async () => {
  render(
    <ViewportBackground
      backgroundColor="#123456"
      panoramaAsset={panoramaAsset}
      panoramaRadius={60}
      panoramaYaw={0}
    />
  );

  act(() => {
    loaderCalls[0]?.onError?.(new Error("texture failed"));
  });

  expect(await screen.findByText("全景图加载失败")).toBeInTheDocument();
  expect(mockScene.background).toBeInstanceOf(Color);
});

it("contains synchronous texture loader crashes so the page does not go black", async () => {
  synchronousLoaderError = new Error("texture loader crashed");

  render(
    <ViewportBackground
      backgroundColor="#123456"
      panoramaAsset={panoramaAsset}
      panoramaRadius={60}
      panoramaYaw={0}
    />
  );

  expect(await screen.findByText("全景图加载失败")).toBeInTheDocument();
  expect(mockScene.background).toBeInstanceOf(Color);
});

it("keeps the owned fallback background during development remount cleanup", () => {
  const { unmount } = render(
    <ViewportBackground
      backgroundColor="#000000"
      panoramaAsset={null}
      panoramaRadius={60}
      panoramaYaw={0}
    />
  );
  const appliedBackground = mockScene.background;

  expect(appliedBackground).toBeInstanceOf(Color);

  unmount();

  expect(mockScene.background).toBe(appliedBackground);
});

it("sets the renderer clear color as a stable fallback for refresh frames", () => {
  render(
    <ViewportBackground
      backgroundColor="#000000"
      panoramaAsset={null}
      panoramaRadius={60}
      panoramaYaw={0}
    />
  );

  expect(mockGl.setClearColor).toHaveBeenCalledWith(expect.any(Color), 1);
});
