import type { AgentRun, AgentRunTask } from "./agent-run-store";

export function agentTaskCompletionMessage(task: AgentRunTask, surface: AgentRun["surface"] = "canvas") {
    if (task.type === "text") {
        const summary = resultSummary(task.result);
        return summary ? `「${task.title}」已完成：\n${sliceUnicode(summary, 1600)}` : `「${task.title}」已完成。`;
    }
    return surface === "canvas" ? `「${task.title}」已生成并返回画布。` : `「${task.title}」已生成。`;
}

export function agentRunCompletionReply(run: AgentRun) {
    const completed = run.tasks.filter((task) => task.status === "completed");
    if (run.generationPreferences?.mode === "text") {
        const content = completed[0]?.result && typeof completed[0].result === "object" ? (completed[0].result as { content?: unknown }).content : undefined;
        return typeof content === "string" && content.trim() ? content.trim() : "文本模型没有返回有效内容";
    }
    if (!completed.length && run.projectHandoff) return "项目资料已整理完成。";
    if (wantsTextOnly(run.prompt) && completed.length === 1 && completed[0].type === "text") {
        return enforceRequestedLength(conciseTextResult(resultSummary(completed[0].result)), run.prompt) || `「${completed[0].title}」已完成。`;
    }
    const visibleTasks = run.surface === "chat" ? completed.filter((task) => task.type === "text") : completed;
    const details = visibleTasks.map((task) => agentTaskCompletionMessage(task, run.surface)).join("\n\n");
    return `已完成 ${completed.length} 个创作任务。${details ? `\n\n${details}` : ""}`;
}

export function agentRunFailureMessage(tasks: AgentRunTask[]) {
    const failed = tasks.filter((task) => task.status === "failed" && task.error?.trim());
    if (!failed.length) return "创作任务执行失败";
    const counts = tasks.reduce(
        (total, task) => {
            if (task.childTasks?.length) {
                total.completed += task.childTasks.filter((child) => child.status === "completed").length;
                total.failed += task.childTasks.filter((child) => child.status === "failed").length;
                return total;
            }
            if (task.status === "completed") total.completed += Math.max(1, task.count);
            if (task.status === "failed") total.failed += Math.max(1, task.count);
            return total;
        },
        { completed: 0, failed: 0 },
    );
    if (!counts.failed) counts.failed = failed.length;
    const unit = tasks.every((task) => task.type === "image") ? "张" : tasks.every((task) => task.type === "video") ? "个视频" : "项";
    const summary = counts.completed ? `生成结果：成功 ${counts.completed} ${unit}，失败 ${counts.failed} ${unit}。` : `生成失败：失败 ${counts.failed} ${unit}。`;
    const reasons = failed.map((task) => `「${task.title}」：${task.error!.trim()}`).join("\n");
    return `${summary}\n失败原因：\n${reasons}`;
}

function wantsTextOnly(prompt: string) {
    return /只需要(?:最终)?文本(?:产物|结果)?|只(?:返回|输出)(?:最终)?(?:文案|文本|结果)|不要解释|直接(?:给|说|返回|输出)(?:我)?(?:答案|结果|文案)|别(?:解释|啰嗦|展开)/.test(prompt);
}

function conciseTextResult(value: string) {
    const paragraph =
        value
            .split(/\n\s*\n/)
            .map((item) => item.trim())
            .find(Boolean) || "";
    const line =
        paragraph
            .split("\n")
            .map((item) => item.trim())
            .find((item) => item && !/^[-*]\s/.test(item)) || "";
    const normalized = line
        .replace(/^#{1,6}\s*/, "")
        .replace(/^「[^」]+」(?:已完成)?[:：]?\s*/, "")
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .trim();
    return sliceUnicode(normalized, 500);
}

function enforceRequestedLength(value: string, prompt: string) {
    const limit = Number(prompt.match(/(?:不超过|最多|控制在|限|)(\d{1,3})\s*字(?:以内|以下|之内)?/)?.[1] || 0);
    if (!limit || !value) return value;
    return sliceUnicode(value, limit);
}

export function resultSummary(value: unknown) {
    if (!value) return "";
    if (typeof value === "string") return sliceUnicode(value, 4000);
    if (typeof value !== "object") return sliceUnicode(String(value), 1000);
    const record = value as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (content) return sliceUnicode(content, 4000);
    const url = [record.remoteUrl, record.serverUrl, record.url, record.dataUrl].find((item) => typeof item === "string" && item);
    return typeof url === "string" ? (url.startsWith("data:") ? "已生成可用媒体产物" : `媒体地址：${url.slice(0, 2000)}`) : sliceUnicode(JSON.stringify(value), 2000);
}

function sliceUnicode(value: string, limit: number) {
    return Array.from(value).slice(0, limit).join("");
}
