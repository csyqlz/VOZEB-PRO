import { CornerDownLeft, Crosshair, LogOut } from "lucide-react";
import type { CameraPilotMode } from "../store/directorStore";

export function PilotHud({
  lockedTargetName,
  onExit,
  onRecord,
  pointedTargetName,
}: {
  lockedTargetName: string | null;
  mode: Exclude<CameraPilotMode, "idle">;
  onExit: () => void;
  onRecord: () => void;
  pointedTargetName: string | null;
}) {
  const targetName = lockedTargetName ?? pointedTargetName;
  const crosshairLabel = lockedTargetName
    ? `掌镜准星，已锁定${lockedTargetName}`
    : pointedTargetName
      ? `掌镜准星，当前对准${pointedTargetName}`
      : "掌镜准星，按 F 锁定当前空间点";

  return (
    <div className="pilot-hud" aria-label="第一人称掌镜控制层">
      <div className="pilot-status" role="status">
        <span className="pilot-status-dot" />
        掌镜模式
      </div>

      <div className={`pilot-crosshair${lockedTargetName ? " is-locked" : targetName ? " is-pointing" : ""}`} aria-label={crosshairLabel}>
        <span className="pilot-crosshair-line is-top" />
        <span className="pilot-crosshair-line is-right" />
        <span className="pilot-crosshair-line is-bottom" />
        <span className="pilot-crosshair-line is-left" />
        <span className="pilot-crosshair-center" />
        {targetName ? (
          <span className="pilot-target-name">
            <Crosshair aria-hidden="true" size={13} />
            {lockedTargetName ? `已锁定：${targetName}` : `${targetName} · 按 F 锁定`}
          </span>
        ) : (
          <span className="pilot-target-name">
            <Crosshair aria-hidden="true" size={13} />
            空白空间 · 按 F 锁定
          </span>
        )}
      </div>

      <div className="pilot-keyboard-help" aria-label="掌镜快捷键">
        <span><kbd>W A S D</kbd> 移动</span>
        <span><kbd>E</kbd> 上升 · <kbd>Q</kbd> 下降</span>
        <span><kbd>空格</kbd> 播放/暂停</span>
        <span><kbd>F</kbd> 锁定主体 / 空间点</span>
        <span><kbd>滚轮</kbd> 调整远近</span>
      </div>

      <div className="pilot-hud-actions">
        <button type="button" className="pilot-hud-secondary" onClick={onExit} aria-label="退出掌镜模式">
          <LogOut aria-hidden="true" size={15} />
          Esc 退出
        </button>
        <button type="button" className="pilot-hud-primary" onClick={onRecord} aria-label="记录当前轨迹点">
          <CornerDownLeft aria-hidden="true" size={15} />
          Enter 记录轨迹点
        </button>
      </div>
    </div>
  );
}
