import type { ReactNode } from "react";
import { ObjectTreePanel } from "../../editor/panels/ObjectTreePanel";
import { RightPanel } from "../../editor/panels/RightPanel";
import { useDirectorStore } from "../../editor/store/directorStore";

export function DirectorDeskShell({ children }: { children: ReactNode }) {
  const viewportPanelsCollapsed = useDirectorStore((state) => state.viewportPanelsCollapsed);
  const motionStudioOpen = useDirectorStore((state) => state.motionStudioOpen);
  const cameraPilotMode = useDirectorStore((state) => state.cameraPilotMode);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const hasCameraPreviewPath = useDirectorStore((state) => {
    const activeCamera = state.project.cameras.find((camera) => camera.id === state.project.activeCameraId)
      ?? state.project.cameras[0];
    return (activeCamera?.motionPath?.keyframes.length ?? 0) >= 2;
  });
  const isCameraPiloting = cameraPilotMode !== "idle";
  const isCameraPreviewing =
    motionStudioOpen && viewMode === "camera" && hasCameraPreviewPath && !isCameraPiloting;

  return (
    <div
      className={[
        "director-shell director-shell-fullbleed",
        viewportPanelsCollapsed ? "is-sidebars-collapsed" : "",
        motionStudioOpen && !isCameraPiloting && !isCameraPreviewing ? "is-motion-studio-open" : "",
        isCameraPiloting ? "is-camera-piloting" : "",
        isCameraPreviewing ? "is-camera-previewing" : "",
      ].filter(Boolean).join(" ")}
    >
      <section className="viewport-column" aria-label="3D视口">
        {children}
      </section>
      <aside
        className="left-sidebar director-sidebar"
        aria-hidden={viewportPanelsCollapsed ? "true" : undefined}
        aria-label="场景"
      >
        <ObjectTreePanel />
      </aside>
      <aside
        className="right-sidebar director-sidebar"
        aria-hidden={viewportPanelsCollapsed ? "true" : undefined}
        aria-label="属性"
      >
        <RightPanel />
      </aside>
    </div>
  );
}
