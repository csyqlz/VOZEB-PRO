import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Drama project Agent references", () => {
    it("renders uploaded references above the user message text", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-panel.tsx"), "utf8");
        const messageSource = source.slice(source.indexOf("messages.map((message)"), source.indexOf("<div ref={endRef}"));

        expect(messageSource).toContain("messageAssetIds(message)");
        expect(messageSource.indexOf("<DramaMessageReferences")).toBeLessThan(messageSource.indexOf("{displayContent}"));
    });

    it("reuses the original request snapshot when an initial submission is retried", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-panel.tsx"), "utf8");

        expect(source).toContain("clientRequestId: submission.clientRequestId");
        expect(source).toContain("failedSubmissionsRef.current.get(assistantMessageId)");
        expect(source).toContain('aria-label="重试本次项目 Agent 请求"');
        expect(source).toContain("metadata: { assetIds }");
        expect(source).toMatch(/messageAssetIds\(message\)\s*\.filter/);
    });

    it("offers stage-aware actions and keeps the project snapshot semantic without arbitrary array slicing", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-panel.tsx"), "utf8");
        const contextSource = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-context.ts"), "utf8");
        const snapshotSource = contextSource.slice(contextSource.indexOf("export function dramaSnapshot"), contextSource.indexOf("export function agentAssetDownloads"));

        expect(source).toContain("DRAMA_AGENT_STAGE_GUIDES");
        expect(contextSource).toContain("检查阶段完成度");
        expect(contextSource).toContain("检查缺失资产");
        expect(contextSource).toContain("检查一致性");
        expect(contextSource).toContain("建议下一步");
        expect(contextSource).toContain("currentStage: stage");
        expect(contextSource).toContain("agentAssetSnapshot");
        expect(source).toContain('styles={{ wrapper: { maxWidth: "calc(100vw - 8px)" }, body: { padding: 0 } }}');
        expect(source).toContain("size={360}");
        expect(source).toContain("mask={false}");
        expect(source).toContain("useState(404)");
        expect(source).toContain('aria-label="调整项目 Agent 面板宽度"');
        expect(source).toContain("Math.min(640, Math.max(348");
        expect(source).not.toContain('title="项目 Agent"');
        expect(source).toContain("data-drama-agent-quick-actions");
        expect(source).toContain("本阶段建议");
        expect(source).toContain('aria-label="打开本阶段 Agent 建议"');
        expect(source).toContain('trigger={["click"]}');
        expect(source).toContain("stageGuide.prompts.map((item, index)");
        expect(source).toContain("fillStagePrompt(item.prompt)");
        expect(source).not.toContain('className="grid grid-cols-2 gap-1.5"');
        expect(source).toContain("data-drama-agent-loading");
        expect(source).toContain("data-drama-agent-empty");
        expect(source).toContain("data-drama-agent-message-scroll");
        expect(source).toContain('listCreativeAgentRuns("drama", { activeOnly: true, projectId: project.id, conversationId })');
        expect(source).toContain("watchRun(activeRun");
        expect(source).toContain("onProgress: (text) => {");
        expect(source).toContain("onTaskCompleted: () => void refreshAssets");
        expect(source).not.toContain("onProgress: () => void refresh");
        expect(source).not.toContain("onTaskCompleted: () => void refresh(run.conversationId)");
        expect(source).toContain("Promise.all([refresh(conversationId), listCreativeAgentRuns");
        expect(source).toContain("activeConversationIdRef.current === conversationId");
        expect(source).toContain("requestId !== conversationLoadRef.current");
        expect(source).toContain("viewRevision: conversationLoadRef.current");
        expect(source).toContain("submission.viewRevision === conversationLoadRef.current");
        expect(source).toContain("viewRevision === conversationLoadRef.current && activeConversationIdRef.current === run.conversationId");
        expect(source).toContain("const requestId = ++conversationLoadRef.current");
        expect(source).toContain("submittingRef.current || uploading || loading");
        expect(source).toContain("disabled={sending || loading}");
        expect(source).toContain('controlCreativeAgentRun(failedMessage.runId, "retry"');
        expect(source).toContain("retryCreativeAgentTasks");
        expect(source).toContain('aria-label="暂停项目 Agent"');
        expect(source).toContain('aria-label="继续项目 Agent"');
        expect(source).toContain("!messages.length ?");
        expect(source).toContain("data-drama-agent-composer");
        expect(source).toContain("data-drama-agent-input-row");
        expect(source).toContain("data-drama-agent-toolbar");
        expect(source).toContain("<textarea");
        expect(source).not.toContain("<Input.TextArea");
        expect(source).toContain("dramaAgentMentionAtCursor");
        expect(source).toContain("<DramaAgentMentionPicker");
        expect(contextSource).toContain("currentTurnReferences");
        expect(source).not.toContain("CompactAgentGenerationSettings");
        expect(source).not.toContain("generationPreferences");
        expect(source).not.toContain("preferences: submission.preferences");
        expect(source).toContain('aria-label="新建项目 Agent 对话"');
        expect(source).toContain('aria-label="打开项目 Agent 历史对话"');
        expect(source).toContain('listCreativeConversationPage({ surface: "drama", source: "drama", projectId: project.id');
        expect(source).toContain("<DramaAgentHistory");
        expect(source).not.toContain("w-[340px]");
        const quickActions = source.slice(source.indexOf("data-drama-agent-empty"), source.indexOf("messages.map((message)"));
        expect(quickActions).toContain("Dropdown");
        expect(quickActions).not.toContain("overflow-x-auto");
        expect(snapshotSource).not.toContain(".slice(");
    });

    it("keeps the project mention picker compact", async () => {
        const picker = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-mention-picker.tsx"), "utf8");

        expect(picker).toContain("w-[min(17rem,calc(100vw-1.5rem))]");
        expect(picker).toContain("max-h-[min(14rem,calc(100dvh-12rem))]");
        expect(picker).toContain('role="tablist"');
        expect(picker).toContain('aria-label="引用项目内容类型"');
        expect(picker).toContain("visibleItems.map");
        expect(picker).not.toContain("<section");
        expect(picker).not.toContain("item.description");
    });
});
