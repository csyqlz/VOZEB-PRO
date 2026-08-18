import { useFrame, useLoader } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import {
  Box3,
  Color,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CharacterRigState, DirectorObject } from "../schema/directorProject";
import { sampleCharacterActionControls } from "../presets/characterActionPresets";
import { getObjectMotionActionSample, getObjectMotionSpeed } from "../schema/objectMotion";
import { getRuntimePlaybackProgress } from "./playbackRuntime";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "../schema/viewportLabels";
import type { CharacterBodyType } from "./mannequin/bodyTypes";
import {
  UE4_MANNEQUIN_MODEL_URL,
  getUE4ModelScale,
} from "./ue4Mannequin/ue4MannequinRig";
import { applyUE4RestPoseAndRig, captureUE4RestPose } from "./ue4Mannequin/ue4MannequinPoseApplication";

interface UE4MannequinModelProps {
  bodyType?: CharacterBodyType;
  color?: string;
  onLabelAnchorYChange?: (anchorY: number) => void;
  rigState?: CharacterRigState;
  runtimeMotion?: { duration: number; object: DirectorObject };
}

interface LoadedGLTF {
  scene: Group;
  animations: unknown[];
}

function isSkinnedMesh(object: Object3D): object is SkinnedMesh {
  return "isSkinnedMesh" in object && object.isSkinnedMesh === true;
}

function tintMaterial(material: Material | Material[], color: string) {
  const materials = Array.isArray(material) ? material : [material];
  const nextColor = new Color(color);

  materials.forEach((item) => {
    if (item instanceof MeshStandardMaterial && item.name !== "SK_Mannequin_M_UE4Man_ChestLogo") {
      item.color.copy(nextColor);
      item.roughness = 0.68;
      item.metalness = 0.04;
      item.needsUpdate = true;
    }
  });
}

function cloneMaterialInstance(material: Material | Material[]) {
  return Array.isArray(material) ? material.map((item) => item.clone()) : material.clone();
}

export function isolateAndTintUE4MannequinMaterials(scene: Object3D, color: string) {
  scene.traverse((object) => {
    object.frustumCulled = false;

    if (isSkinnedMesh(object)) {
      object.castShadow = true;
      object.receiveShadow = true;

      if (!object.userData.storyAiIsolatedMaterial) {
        object.material = cloneMaterialInstance(object.material);
        object.userData.storyAiIsolatedMaterial = true;
      }

      tintMaterial(object.material, color);
    }
  });
}

function getBoundsInParentLocal(object: Object3D) {
  (object.parent ?? object).updateMatrixWorld(true);

  const worldBounds = new Box3().setFromObject(object, true);
  if (!object.parent || worldBounds.isEmpty()) return worldBounds;

  const parentInverse = new Matrix4().copy(object.parent.matrixWorld).invert();
  const bounds = new Box3().makeEmpty();
  const vertex = new Vector3();
  const xValues = [worldBounds.min.x, worldBounds.max.x];
  const yValues = [worldBounds.min.y, worldBounds.max.y];
  const zValues = [worldBounds.min.z, worldBounds.max.z];

  xValues.forEach((x) => {
    yValues.forEach((y) => {
      zValues.forEach((z) => {
        vertex.set(x, y, z).applyMatrix4(parentInverse);
        bounds.expandByPoint(vertex);
      });
    });
  });

  return bounds;
}

export function alignUE4MannequinToGround(scene: Object3D) {
  const rootX = scene.position.x;
  const rootZ = scene.position.z;

  function measureBoundsInParentLocal() {
    return getBoundsInParentLocal(scene);
  }

  scene.position.set(rootX, 0, rootZ);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bounds = measureBoundsInParentLocal();
    const correctionY = bounds.isEmpty() || !Number.isFinite(bounds.min.y) ? 0 : -bounds.min.y;

    if (Math.abs(correctionY) < 0.00001) break;

    scene.position.set(rootX, scene.position.y + correctionY, rootZ);
  }

  scene.position.set(rootX, scene.position.y, rootZ);
  (scene.parent ?? scene).updateMatrixWorld(true);

  return scene.position.y;
}

export function UE4MannequinModel({
  bodyType = "mannequin",
  color = "#F3F5F7",
  onLabelAnchorYChange,
  rigState,
  runtimeMotion,
}: UE4MannequinModelProps) {
  const gltf = useLoader(GLTFLoader, UE4_MANNEQUIN_MODEL_URL) as LoadedGLTF;
  const scene = useMemo(() => cloneSkeleton(gltf.scene) as Group, [gltf.scene]);
  const restPose = useMemo(() => captureUE4RestPose(scene), [scene]);
  const modelScale = getUE4ModelScale(bodyType);

  useLayoutEffect(() => {
    isolateAndTintUE4MannequinMaterials(scene, color);

    applyUE4RestPoseAndRig(scene, {
      bodyType,
      controls: rigState?.controls ?? {},
      restPose,
    });
    alignUE4MannequinToGround(scene);

    const modelRoot = scene.parent ?? scene;
    const bounds = getBoundsInParentLocal(modelRoot);
    const labelAnchorY = bounds.max.y + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP;

    if (Number.isFinite(labelAnchorY)) {
      onLabelAnchorYChange?.(Number(labelAnchorY.toFixed(4)));
    }
  }, [bodyType, color, onLabelAnchorYChange, restPose, rigState?.controls, scene]);

  useFrame(() => {
    if (!runtimeMotion) return;
    const progress = getRuntimePlaybackProgress();
    const actionSample = getObjectMotionActionSample(runtimeMotion.object, progress, runtimeMotion.duration);
    const routeAction = actionSample.actionPresetId;
    const isMoving = getObjectMotionSpeed(runtimeMotion.object, progress, runtimeMotion.duration) > 0.05;
    const actionPresetId = routeAction ?? (isMoving ? "walk-cycle" : runtimeMotion.object.characterRig?.actionPresetId);
    const controls = actionPresetId
      ? sampleCharacterActionControls(actionPresetId, actionSample.animationTimeSeconds, rigState?.controls ?? {})
      : rigState?.controls ?? {};
    applyUE4RestPoseAndRig(scene, { bodyType, controls, restPose });
    scene.updateMatrixWorld(true);
  });

  return (
    <group name={`ue-retopology-mannequin-${bodyType}`} scale={modelScale}>
      <primitive object={scene} />
    </group>
  );
}
