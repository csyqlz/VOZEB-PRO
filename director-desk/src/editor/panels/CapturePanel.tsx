import { useState } from "react";
import { requestViewportCapture } from "../io/captureBridge";
import { serializeProject } from "../io/exportProjectJson";
import { parseProject } from "../io/importProjectJson";
import { downloadCaptureResults } from "../io/screenshotExport";
import { useDirectorStore } from "../store/directorStore";

export function CapturePanel() {
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const project = useDirectorStore((state) => state.project);
  const replaceProject = useDirectorStore((state) => state.replaceProject);
  const saveLatestSnapshot = useDirectorStore((state) => state.saveLatestSnapshot);
  const restoreLatestSnapshot = useDirectorStore((state) => state.restoreLatestSnapshot);

  async function handleCapture(preset: "current" | "four" | "twelve") {
    try {
      const results = await requestViewportCapture({
        preset,
        source: "capture-panel",
      });
      const count = downloadCaptureResults(results);
      setCaptureStatus(`已导出 ${count} 张截图`);
    } catch (error) {
      setCaptureStatus(error instanceof Error ? error.message : "截图失败");
    }
  }

  return (
    <section className="panel-card">
      <h2>截图</h2>
      <button className="capture-action" type="button" onClick={() => void handleCapture("current")}>
        当前视角截图
      </button>
      <button className="capture-action" type="button" onClick={() => void handleCapture("four")}>
        四方位截图
      </button>
      <button className="capture-action" type="button" onClick={() => void handleCapture("twelve")}>
        十二方位截图
      </button>
      {captureStatus ? <p className="capture-status">{captureStatus}</p> : null}
      <button
        className="capture-action"
        type="button"
        onClick={() => {
          const blob = new Blob([serializeProject(project)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          window.open(url, "_blank");
        }}
      >
        导出工程 JSON
      </button>
      <input
        className="ui-field"
        aria-label="导入工程 JSON"
        accept="application/json"
        type="file"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          replaceProject(parseProject(await file.text()));
        }}
      />
      <button className="capture-action" type="button" onClick={saveLatestSnapshot}>
        保存最近工程
      </button>
      <button className="capture-action" type="button" onClick={restoreLatestSnapshot}>
        恢复最近工程
      </button>
    </section>
  );
}
