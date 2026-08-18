import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { PropPanel } from "../PropPanel";

beforeEach(() => {
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
          color: "#d7e7ff",
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
});

it("renders the prop inspector fields for imported models", () => {
  render(<PropPanel />);

  expect(screen.getByText("模型")).toBeInTheDocument();
  expect(screen.getByLabelText("模型名称")).toBeInTheDocument();
  expect(screen.getByLabelText("模型位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型旋转 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型缩放 X")).toBeInTheDocument();
  expect(screen.getByLabelText("模型统一缩放")).toBeInTheDocument();
  expect(screen.getByLabelText("模型颜色 HEX")).toBeInTheDocument();
});

it("updates the selected prop name, uniform scale, and color", async () => {
  const user = userEvent.setup();
  render(<PropPanel />);

  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "近景 ATM");
  await user.clear(screen.getByLabelText("模型统一缩放"));
  await user.type(screen.getByLabelText("模型统一缩放"), "1.4");
  await user.clear(screen.getByLabelText("模型颜色 HEX"));
  await user.type(screen.getByLabelText("模型颜色 HEX"), "#aaccee");

  const prop = useDirectorStore.getState().project.objects.find((item) => item.id === "prop_model_1");
  expect(prop?.name).toBe("近景 ATM");
  expect(prop?.transform.scale).toEqual([1.4, 1.4, 1.4]);
  expect(prop?.color).toBe("#aaccee");
});
