import { MathUtils, Vector3 } from "three";
import type { CameraMotionSnapshot } from "../schema/cameraMotion";
import type { DirectorCameraMotionPath } from "../schema/directorProject";
import type {
  DirectorCameraTargetBodyPart,
  DirectorCameraTargetFollowMode,
} from "../schema/semanticBody";

export type CameraPathTemplateId =
  | "push-in"
  | "pull-out"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "truck-left"
  | "truck-right"
  | "crane-orbit-up"
  | "follow"
  | "parallel-follow"
  | "handheld"
  | "over-shoulder-reveal"
  | "orbit-close"
  | "crane-orbit-down"
  | "low-angle-follow"
  | "overhead-follow"
  | "foreground-reveal";

export interface CameraPathTemplateDefinition {
  id: CameraPathTemplateId;
  label: string;
  description: string;
  duration: number;
  group: "official" | "community";
  suitableFor: string;
  version: string;
  contribution?: CameraPathTemplateContribution;
}

export interface CameraPathTemplateContribution {
  contributorName: string | null;
  contact: string | null;
  sourceUrl: string | null;
  license: string;
}

const COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG: CameraPathTemplateContribution = {
  contributorName: "AIGC 耀光",
  contact: "抖音号：AIJPDM001",
  sourceUrl: null,
  license: "群友提供镜头预设构想，项目内置实现",
};

export const CAMERA_PATH_TEMPLATES: CameraPathTemplateDefinition[] = [
  { id: "push-in", label: "推镜", description: "由远到近靠近主体", duration: 5, group: "official", suitableFor: "人物介绍、情绪强调", version: "1.0.0" },
  { id: "pull-out", label: "拉镜", description: "由近到远离开主体", duration: 5, group: "official", suitableFor: "环境揭示、段落收尾", version: "1.0.0" },
  { id: "pan-left", label: "左摇镜", description: "向主体左侧环摇", duration: 5, group: "official", suitableFor: "空间关系、人物观察", version: "1.0.0" },
  { id: "pan-right", label: "右摇镜", description: "向主体右侧环摇", duration: 5, group: "official", suitableFor: "空间关系、人物观察", version: "1.0.0" },
  { id: "tilt-up", label: "俯仰抬镜", description: "从低位抬升视角", duration: 5, group: "official", suitableFor: "人物亮相、强调高度", version: "1.0.0" },
  { id: "tilt-down", label: "俯拍压镜", description: "从高位压低视角", duration: 5, group: "official", suitableFor: "环境交代、俯视主体", version: "1.0.0" },
  { id: "truck-left", label: "左移镜", description: "横向移动制造视差", duration: 5, group: "official", suitableFor: "场景层次、横向揭示", version: "1.0.0" },
  { id: "truck-right", label: "右移镜", description: "横向移动制造视差", duration: 5, group: "official", suitableFor: "场景层次、横向揭示", version: "1.0.0" },
  { id: "crane-orbit-up", label: "环绕摇臂升镜", description: "一边环绕一边升高", duration: 8, group: "community", suitableFor: "人物出场、场景揭示、高潮镜头", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "follow", label: "跟拍", description: "保持距离跟随运动主体", duration: 6, group: "community", suitableFor: "走路、跑步、运动主体", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "parallel-follow", label: "平行跟拍", description: "在主体侧面同步移动", duration: 6, group: "community", suitableFor: "人物行进、车辆侧拍", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "handheld", label: "手持晃镜", description: "轻微不规则手持运动", duration: 6, group: "community", suitableFor: "纪实、紧张、主观现场感", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "over-shoulder-reveal", label: "过肩绕正面", description: "从人物侧后方绕到正面", duration: 7, group: "community", suitableFor: "对话、人物亮相、情绪转折", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "orbit-close", label: "近景半环绕", description: "保持近景距离做半环绕", duration: 7, group: "community", suitableFor: "人物特写、产品细节", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "crane-orbit-down", label: "环绕摇臂降镜", description: "一边环绕一边降低机位", duration: 8, group: "community", suitableFor: "落到主体、从全景进入表演", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "low-angle-follow", label: "低机位追拍", description: "贴近地面跟随运动主体", duration: 6, group: "community", suitableFor: "奔跑、车辆、力量感", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "overhead-follow", label: "俯视跟拍", description: "从主体上方同步跟随", duration: 6, group: "community", suitableFor: "路线交代、群像、运动场面", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
  { id: "foreground-reveal", label: "横移揭示", description: "横向越过前景逐步露出主体", duration: 6, group: "community", suitableFor: "悬念揭示、空间转场", version: "1.0.0", contribution: COMMUNITY_CONTRIBUTION_AIGC_YAOGUANG },
];

export function getCameraPathTemplatesByGroup(group: CameraPathTemplateDefinition["group"]) {
  return CAMERA_PATH_TEMPLATES.filter((template) => template.group === group);
}

const STANDARD_TIMES = [0, 0.5, 1];
const HANDHELD_TIMES = [0, 0.16, 0.33, 0.5, 0.67, 0.84, 1];
const CINEMATIC_TIMES = [0, 0.25, 0.5, 0.75, 1];

function tuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

function getTemplateTimes(templateId: CameraPathTemplateId) {
  if (templateId === "handheld") return HANDHELD_TIMES;
  if (templateId === "over-shoulder-reveal" || templateId === "orbit-close") return CINEMATIC_TIMES;
  return STANDARD_TIMES;
}

export function createCameraPathTemplate({
  cameraId,
  focusAt,
  scale = 1,
  snapshot,
  targetObjectId = null,
  targetBodyPart = "center",
  targetFollowMode = "immediate",
  templateId,
}: {
  cameraId: string;
  focusAt: (progress: number) => [number, number, number];
  scale?: number;
  snapshot: CameraMotionSnapshot;
  targetObjectId?: string | null;
  targetBodyPart?: DirectorCameraTargetBodyPart;
  targetFollowMode?: DirectorCameraTargetFollowMode;
  templateId: CameraPathTemplateId;
}): DirectorCameraMotionPath {
  const definition = CAMERA_PATH_TEMPLATES.find((item) => item.id === templateId);
  if (!definition) throw new Error(`Unknown camera path template: ${templateId}`);
  const range = MathUtils.clamp(Number.isFinite(scale) ? scale : 1, 0.25, 3);
  const motionRange = definition.group === "community" ? 1 : range;
  const times = getTemplateTimes(templateId);
  const middleFocus = new Vector3(...focusAt(0.5));
  const baseOffset = new Vector3(...snapshot.position).sub(middleFocus);
  if (baseOffset.lengthSq() < 0.25) baseOffset.set(0, 1.4, 6);
  const horizontalRadial = new Vector3(baseOffset.x, 0, baseOffset.z);
  if (horizontalRadial.lengthSq() < 0.0001) horizontalRadial.set(0, 0, 1);
  horizontalRadial.normalize();
  const forward = horizontalRadial.clone().multiplyScalar(-1);
  const up = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(forward, up).normalize();
  const movement = new Vector3(...focusAt(1)).sub(new Vector3(...focusAt(0)));
  movement.y = 0;
  const hasTargetMovement = movement.lengthSq() > 0.0001;
  const movingSide = hasTargetMovement
    ? new Vector3().crossVectors(movement.normalize(), up).normalize()
    : right.clone();
  const baseDistance = Math.max(2, baseOffset.length());
  const handheldJitter = [
    [0, 0, 0], [.08, .04, -.03], [-.05, -.03, .04], [.06, -.02, 0],
    [-.07, .03, -.02], [.04, -.04, .03], [0, 0, 0],
  ] as const;

  const offsetAt = (progress: number, index: number) => {
    const centered = progress - 0.5;
    if (templateId === "push-in" || templateId === "pull-out") {
      const direction = templateId === "push-in" ? -1 : 1;
      return baseOffset.clone().multiplyScalar(1 + direction * centered * 0.7 * motionRange);
    }
    if (templateId === "pan-left" || templateId === "pan-right") {
      const direction = templateId === "pan-left" ? -1 : 1;
      return baseOffset.clone().applyAxisAngle(up, direction * centered * MathUtils.degToRad(55) * motionRange);
    }
    if (templateId === "tilt-up" || templateId === "tilt-down") {
      const direction = templateId === "tilt-up" ? -1 : 1;
      return baseOffset.clone().applyAxisAngle(right, direction * centered * MathUtils.degToRad(42) * motionRange);
    }
    if (templateId === "truck-left" || templateId === "truck-right") {
      const direction = templateId === "truck-left" ? -1 : 1;
      return baseOffset.clone().addScaledVector(right, direction * centered * baseDistance * 0.75 * motionRange);
    }
    if (templateId === "crane-orbit-up") {
      return baseOffset
        .clone()
        .applyAxisAngle(up, progress * MathUtils.degToRad(65) * motionRange)
        .addScaledVector(up, progress * baseDistance * 0.45 * motionRange);
    }
    if (templateId === "parallel-follow") {
      if (!hasTargetMovement) {
        return baseOffset.clone().addScaledVector(right, centered * baseDistance * 0.9 * motionRange);
      }
      return movingSide.clone().multiplyScalar(baseDistance).addScaledVector(up, Math.max(0.8, baseOffset.y));
    }
    if (templateId === "follow") {
      return baseOffset.clone().addScaledVector(horizontalRadial, centered * baseDistance * 0.18 * motionRange);
    }
    if (templateId === "over-shoulder-reveal") {
      return baseOffset
        .clone()
        .applyAxisAngle(up, MathUtils.degToRad(-30 + progress * 105) * motionRange)
        .multiplyScalar(1 - progress * 0.28);
    }
    if (templateId === "orbit-close") {
      return baseOffset
        .clone()
        .multiplyScalar(0.72)
        .applyAxisAngle(up, centered * MathUtils.degToRad(125) * motionRange);
    }
    if (templateId === "crane-orbit-down") {
      return baseOffset
        .clone()
        .applyAxisAngle(up, progress * MathUtils.degToRad(65) * motionRange)
        .addScaledVector(up, -progress * Math.max(0.8, baseOffset.y) * 0.7 * motionRange);
    }
    if (templateId === "low-angle-follow") {
      return horizontalRadial
        .clone()
        .multiplyScalar(baseDistance * 0.82)
        .addScaledVector(up, 0.35)
        .addScaledVector(right, centered * baseDistance * 0.25 * motionRange);
    }
    if (templateId === "overhead-follow") {
      return horizontalRadial
        .clone()
        .multiplyScalar(baseDistance * 0.32)
        .addScaledVector(up, Math.max(3, baseDistance * 1.05))
        .addScaledVector(right, centered * baseDistance * 0.2 * motionRange);
    }
    if (templateId === "foreground-reveal") {
      return baseOffset
        .clone()
        .addScaledVector(right, centered * baseDistance * 1.35 * motionRange)
        .addScaledVector(horizontalRadial, -progress * baseDistance * 0.18 * motionRange);
    }
    const jitter = handheldJitter[index] ?? handheldJitter[0];
    return baseOffset
      .clone()
      .addScaledVector(right, jitter[0] * baseDistance * motionRange)
      .addScaledVector(up, jitter[1] * baseDistance * motionRange)
      .addScaledVector(horizontalRadial, jitter[2] * baseDistance * motionRange);
  };

  return {
    duration: definition.duration,
    loop: false,
    interpolation: templateId === "handheld" ? "linear" : "smooth",
    easing: templateId === "handheld" ? "linear" : "ease-in-out",
    keyframes: times.map((time, index) => {
      const focus = new Vector3(...focusAt(time));
      const offset = offsetAt(time, index);
      if (definition.group === "community") offset.multiplyScalar(range);
      const position = focus.clone().add(offset);
      return {
        id: `${cameraId}_${templateId}_${index + 1}`,
        time,
        position: tuple(position),
        target: tuple(focus),
        fov: snapshot.fov,
        targetMode: targetObjectId ? "object" : "manual",
        targetObjectId,
        targetBodyPart,
        targetFollowMode,
      };
    }),
  };
}
