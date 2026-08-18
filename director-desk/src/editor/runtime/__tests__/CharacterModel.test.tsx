import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { CharacterModel } from "../CharacterModel";

vi.mock("../UE4MannequinModel", () => ({
  UE4MannequinModel: ({ bodyType }: { bodyType?: string }) => (
    <div data-body-type={bodyType} data-testid="mock-ue4-mannequin" />
  ),
}));

vi.mock("../PrimitiveMannequin", () => ({
  PrimitiveMannequin: ({ bodyType }: { bodyType?: string }) => (
    <div data-body-type={bodyType} data-testid="mock-procedural-mannequin" />
  ),
}));

vi.mock("../MixamoCharacterModel", () => ({
  MixamoCharacterModel: ({
    actionPresetId,
    animationTimeSeconds,
    externalAnimation,
    url,
  }: {
    actionPresetId?: string | null;
    animationTimeSeconds?: number;
    externalAnimation?: { url: string; clipName: string } | null;
    url: string;
  }) => (
    <div
      data-action-preset-id={actionPresetId}
      data-animation-time={animationTimeSeconds}
      data-external-animation-url={externalAnimation?.url}
      data-external-clip-name={externalAnimation?.clipName}
      data-testid="mock-mixamo-character"
      data-url={url}
    />
  ),
}));

it("renders the built-in UE4 mannequin for generated director characters", () => {
  render(
    <CharacterModel
      bodyType="female"
      rigState={{
        rigType: "ue4-mannequin",
        posePresetId: "stand",
        controls: {},
      }}
    />
  );

  expect(screen.getByTestId("mock-ue4-mannequin")).toHaveAttribute("data-body-type", "female");
  expect(screen.queryByTestId("mock-procedural-mannequin")).not.toBeInTheDocument();
});

it("keeps the procedural mannequin fallback for non-UE4 rigs", () => {
  render(
    <CharacterModel
      bodyType="chibi"
      rigState={{
        rigType: "mannequin",
        posePresetId: "stand",
        controls: {},
      }}
    />
  );

  expect(screen.getByTestId("mock-procedural-mannequin")).toHaveAttribute("data-body-type", "chibi");
  expect(screen.queryByTestId("mock-ue4-mannequin")).not.toBeInTheDocument();
});

it("forwards the shared timeline time and action to Mixamo characters", () => {
  render(
    <CharacterModel
      actionPresetId="walk-cycle"
      animationTimeSeconds={2.75}
      assetUrl="/characters/remy.fbx"
      rigState={{
        rigType: "mixamo",
        posePresetId: "stand",
        controls: {},
      }}
    />
  );

  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-url", "/characters/remy.fbx");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-action-preset-id", "walk-cycle");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-animation-time", "2.75");
});

it("forwards an independently imported animation source to the character runtime", () => {
  render(
    <CharacterModel
      actionPresetId="imported-action:walk:clip_1"
      animationTimeSeconds={0.5}
      assetFormat="fbx"
      assetUrl="/characters/actor.fbx"
      externalAnimation={{ url: "/animations/walk.fbx", format: "fbx", clipName: "Walk" }}
      rigState={{ rigType: "mixamo", posePresetId: "stand", controls: {} }}
    />
  );

  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-external-animation-url", "/animations/walk.fbx");
  expect(screen.getByTestId("mock-mixamo-character")).toHaveAttribute("data-external-clip-name", "Walk");
});
