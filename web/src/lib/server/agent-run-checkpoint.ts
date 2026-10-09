type EcommerceCheckpointRun = {
    ecommerceSnapshot?: { fallback?: { reason?: string } };
};

type EcommerceCheckpointTask = {
    status?: string;
    taskId?: string;
    taskIds?: string[];
    childTasks?: unknown[];
    sceneProtection?: unknown;
    ecommerceExecution?: { state?: string };
};

const unresolvedEcommerceCheckpointReasons = new Set([
    "invalid_reference_selection",
    "missing_product_anchor",
    "visual_analysis_unavailable",
    "reference_source_unavailable",
    "reference_source_changed",
    "reference_purpose_confirmation_required",
    "reference_cue_unreliable",
    "reference_roles_need_review",
    "product_edit_not_supported",
    "local_edit_visual_ambiguity",
    "canvas_baseline_unavailable",
    "scene_style_reference_unsupported",
    "unsupported_image_provider_profile",
    "image_provider_needs_review",
    "scene_selection_required",
]);

export function hasUnresolvedEcommerceCheckpoint(run: EcommerceCheckpointRun, task: EcommerceCheckpointTask): boolean {
    const reason = run.ecommerceSnapshot?.fallback?.reason;
    if (!reason || !unresolvedEcommerceCheckpointReasons.has(reason)) return false;
    if (task.taskId || task.taskIds?.length || task.childTasks?.length) return false;
    if (reason === "scene_selection_required") return !task.sceneProtection;
    return task.ecommerceExecution?.state !== "ready";
}

export function ecommerceCheckpointMessage(task: EcommerceCheckpointTask) {
    return typeof task === "object" && task && "error" in task && typeof (task as { error?: unknown }).error === "string" ? (task as { error: string }).error : "任务已暂停等待复核，并保留原任务身份";
}
