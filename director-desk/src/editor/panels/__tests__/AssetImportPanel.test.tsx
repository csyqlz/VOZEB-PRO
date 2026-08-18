import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { AssetImportPanel } from "../AssetImportPanel";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:uploaded"),
  });
});

it("imports a local OBJ/FBX/GLB model from the single local model entry", async () => {
  const user = userEvent.setup();
  render(<AssetImportPanel />);

  expect(screen.getByText("导入本地模型")).toBeInTheDocument();
  expect(screen.queryByText("导入角色模型")).not.toBeInTheDocument();
  expect(screen.queryByText("导入场景模型")).not.toBeInTheDocument();
  expect(screen.queryByText("导入道具模型")).not.toBeInTheDocument();

  const input = screen.getByLabelText("导入本地模型");
  expect(input).toHaveAttribute("accept", ".fbx,.obj,.glb");

  const file = new File(["demo"], "football.obj", { type: "model/obj" });
  await user.upload(input, file);

  await waitFor(() => {
    expect(
      useDirectorStore.getState().project.objects.some((item) => item.name === "football")
    ).toBe(true);
  });

  const latestAsset =
    useDirectorStore.getState().project.assets[useDirectorStore.getState().project.assets.length - 1];
  expect(latestAsset?.fileName).toBe("football.obj");
  expect(screen.getByText("已导入本地模型: football.obj")).toBeInTheDocument();
});
