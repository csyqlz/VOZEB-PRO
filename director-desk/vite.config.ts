import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localGuoAssetsAvailable = existsSync(resolve(process.cwd(), "public/local-assets/guo-3d-assets"));
const appVersion = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version ?? "0.0.0";
const requiredMixamoCharacters = ["camille.fbx", "xbot.glb", "soldier.glb"];
const localMixamoCharacterAvailable = requiredMixamoCharacters.every((fileName) =>
  existsSync(resolve(process.cwd(), "public/local-assets/mixamo/characters", fileName))
);
const requiredMixamoAnimations = [
  "walk.fbx",
  "run.fbx",
  "sit-stand.fbx",
  "side-step-left.fbx",
  "jump.fbx",
  "wave.fbx",
];
const localMixamoAnimationsAvailable = requiredMixamoAnimations.every((fileName) =>
  existsSync(resolve(process.cwd(), "public/local-assets/mixamo/animations", fileName))
);

export default defineConfig({
  base: "./",
  assetsInclude: ["**/*.fbx", "**/*.glb", "**/*.obj"],
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __LOCAL_GUO_ASSETS_AVAILABLE__: JSON.stringify(localGuoAssetsAvailable),
    __LOCAL_MIXAMO_CHARACTER_AVAILABLE__: JSON.stringify(localMixamoCharacterAvailable),
    __LOCAL_MIXAMO_ANIMATIONS_AVAILABLE__: JSON.stringify(localMixamoAnimationsAvailable),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        actionRuntimeSmoke: resolve(process.cwd(), "examples/experiments/action-runtime-smoke.html"),
        characterImportSmoke: resolve(process.cwd(), "examples/experiments/character-import-smoke.html"),
        panoramaExportSmoke: resolve(process.cwd(), "examples/experiments/panorama-export-smoke.html"),
        routeActionSmoke: resolve(process.cwd(), "examples/experiments/route-action-smoke.html"),
        gaussianSplatExperiment: resolve(process.cwd(), "examples/experiments/gaussian-splat-experiment.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    maxWorkers: 1,
    setupFiles: "./src/test/setup.ts",
  },
});
