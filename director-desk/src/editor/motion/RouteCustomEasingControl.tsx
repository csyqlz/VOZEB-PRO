import type { DirectorRouteCubicBezier } from "../schema/directorProject";
import {
  ROUTE_CUSTOM_EASING_PRESETS,
  findRouteCustomEasingPresetId,
} from "./routeCustomEasingPresets";

export function RouteCustomEasingControl({
  curve,
  label = "段内节奏",
  onChange,
}: {
  curve?: DirectorRouteCubicBezier;
  label?: string;
  onChange: (curve: DirectorRouteCubicBezier) => void;
}) {
  const activeId = findRouteCustomEasingPresetId(curve);
  return (
    <div className="route-custom-easing" role="group" aria-label={label}>
      <span>{label}</span>
      <div>
        {ROUTE_CUSTOM_EASING_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={activeId === preset.id}
            onClick={() => onChange([...preset.curve] as DirectorRouteCubicBezier)}
          >{preset.label}</button>
        ))}
      </div>
    </div>
  );
}
