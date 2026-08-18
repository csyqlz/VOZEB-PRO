import { Component, type ReactNode } from "react";
import type { CharacterRigState, DirectorModelFormat, DirectorObject } from "../schema/directorProject";
import type { DirectorCharacterBoneMap } from "../schema/semanticBody";
import { PrimitiveMannequin } from "./PrimitiveMannequin";
import { UE4MannequinModel } from "./UE4MannequinModel";
import type { CharacterBodyType } from "./mannequin/bodyTypes";
import { MixamoCharacterModel, type ExternalCharacterAnimation } from "./MixamoCharacterModel";

interface CharacterModelProps {
  actionPresetId?: string | null;
  animationTimeSeconds?: number;
  bodyType?: CharacterBodyType;
  color?: string;
  onLabelAnchorYChange?: (anchorY: number) => void;
  rigState?: CharacterRigState;
  /** Signals that the parent has applied an automatic locomotion pose. */
  motionWalking?: boolean;
  assetUrl?: string;
  assetFormat?: DirectorModelFormat;
  externalAnimation?: ExternalCharacterAnimation | null;
  orientationCorrection?: [number, number, number];
  runtimeMotion?: { duration: number; object: DirectorObject };
  boneMap?: DirectorCharacterBoneMap;
}

class CharacterModelBoundary extends Component<
  {
    fallback: ReactNode;
    children: ReactNode;
  },
  {
    hasError: boolean;
  }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function CharacterModel({
  actionPresetId,
  animationTimeSeconds,
  assetUrl,
  assetFormat,
  externalAnimation,
  orientationCorrection,
  bodyType,
  color,
  onLabelAnchorYChange,
  rigState,
  runtimeMotion,
  boneMap,
}: CharacterModelProps) {
  const fallback = (
    <PrimitiveMannequin
      bodyType={bodyType}
      color={color}
      rigState={rigState}
      runtimeMotion={runtimeMotion}
    />
  );

  if (assetUrl && rigState?.rigType === "mixamo") {
    return (
      <CharacterModelBoundary fallback={fallback}>
        <MixamoCharacterModel
          actionPresetId={actionPresetId}
          animationTimeSeconds={animationTimeSeconds}
          url={assetUrl}
          format={assetFormat}
          externalAnimation={externalAnimation}
          orientationCorrection={orientationCorrection}
          onLabelAnchorYChange={onLabelAnchorYChange}
          rigState={rigState}
          runtimeMotion={runtimeMotion}
          boneMap={boneMap}
          color={color}
        />
      </CharacterModelBoundary>
    );
  }

  if (rigState?.rigType !== "ue4-mannequin") {
    return fallback;
  }

  return (
    <CharacterModelBoundary fallback={fallback}>
      <UE4MannequinModel
        bodyType={bodyType}
        color={color}
        onLabelAnchorYChange={onLabelAnchorYChange}
        rigState={rigState}
        runtimeMotion={runtimeMotion}
      />
    </CharacterModelBoundary>
  );
}
