import { render, screen } from "@testing-library/react";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { RightPanel } from "../RightPanel";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("shows the scene panel in director mode when nothing is selected", () => {
  render(<RightPanel />);

  expect(screen.getByText("3D场景")).toBeInTheDocument();
});

it("shows the role panel when a role is selected", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
  });

  render(<RightPanel />);

  expect(screen.getByText("角色")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "属性" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "姿势" })).toBeInTheDocument();
});

it("shows the role panel when a crowd group is selected", () => {
  useDirectorStore.getState().addCrowdCharacters({ rows: 3, columns: 3, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<RightPanel />);

  expect(screen.getByText("角色")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "属性" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "姿势" })).toBeInTheDocument();
});

it("shows the camera panel when a camera object is selected", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "cam_object_1",
  });

  render(<RightPanel />);

  expect(screen.getByText("摄像机")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "摄像机截图" })).toBeInTheDocument();
});

it("shows the prop panel when an imported model is selected", () => {
  const base = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...base,
    selectedObjectId: "prop_model_1",
    project: {
      ...base.project,
      assets: [
        {
          id: "asset_model_1",
          kind: "prop",
          sourceType: "model",
          fileName: "ATM_low.fbx",
          url: "blob:atm",
        },
      ],
      objects: [
        ...base.project.objects,
        {
          id: "prop_model_1",
          name: "自动取款机",
          kind: "prop",
          visible: true,
          locked: false,
          assetRefId: "asset_model_1",
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
    },
  });

  render(<RightPanel />);

  expect(screen.getByText("模型")).toBeInTheDocument();
  expect(screen.getByLabelText("模型名称")).toBeInTheDocument();
});

it("falls back to the active camera panel in camera mode when nothing is selected", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewMode: "camera",
    selectedObjectId: null,
  });

  render(<RightPanel />);

  expect(screen.getByText("摄像机")).toBeInTheDocument();
});
