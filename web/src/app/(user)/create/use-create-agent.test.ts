import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("useCreateAgent submission retry", () => {
    it("keeps newly selected files as local drafts until the user submits", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const draftStoreSource = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-draft-attachments-store.ts"), "utf8");
        const uploadStart = source.indexOf("const uploadAttachments");
        const materializeStart = source.indexOf("const materializeDraftAttachments", uploadStart);
        const watchStart = source.indexOf("const watchRun", materializeStart);
        const submitStart = source.indexOf("const submit =", watchStart);
        const uploadSource = source.slice(uploadStart, materializeStart);
        const materializeSource = source.slice(materializeStart, watchStart);
        const submitSource = source.slice(submitStart, source.indexOf("const retrySubmission", submitStart));

        expect(uploadSource).toContain("addDraftAttachments(files");
        expect(uploadSource).not.toContain("ensureConversation");
        expect(uploadSource).not.toContain("uploadCreativeAsset");
        expect(draftStoreSource).toContain("URL.createObjectURL(file)");
        expect(draftStoreSource).not.toContain("localStorage");
        expect(materializeSource).toContain("await ensureConversation(generation)");
        expect(materializeSource).toContain("await uploadCreativeAsset(materializedConversationId, draft.file)");
        expect(submitSource.indexOf("await materializeDraftAttachments(selectedIds)")).toBeLessThan(submitSource.indexOf("executeSubmission(snapshot)"));
    });

    it("reuses the original request and keeps attachments on the original user message", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const executeStart = source.indexOf("const executeSubmission");
        const submitStart = source.indexOf("const submit =", executeStart);
        const retryStart = source.indexOf("const retrySubmission", submitStart);
        const executeSource = source.slice(executeStart, submitStart);
        const submitSource = source.slice(submitStart, retryStart);
        const retrySource = source.slice(retryStart, source.indexOf("const cancel", retryStart));

        expect(executeSource).toContain("clientRequestId: snapshot.clientRequestId");
        expect(executeSource).toContain("preferences: snapshot.preferences");
        expect(submitSource).toContain("metadata: { assetIds }");
        expect(submitSource).toContain("options?.assetIds || selectedAssetIdsWithDrafts");
        expect(submitSource).toContain("setSelectedAssetIds((current) => current.filter");
        expect(retrySource).toContain("failedSubmissionsRef.current.get(assistantMessageId)");
        expect(retrySource).toContain("executeSubmission(snapshot)");
        expect(retrySource).not.toContain("setMessages((current) => [");
    });

    it("retries a failed planning run through the existing server run", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const retryStart = source.indexOf("const retryRun");
        const retrySource = source.slice(retryStart, source.indexOf("const renameConversation", retryStart));

        expect(retrySource).toContain('controlCreativeAgentRun(runId, "retry", expectedConversationId)');
        expect(retrySource).toContain("setRunDetails");
        expect(retrySource).toContain("watchRun(result.run, assistantMessage.id");
        expect(retrySource).not.toContain("createCreativeAgentRun");
    });

    it("directly retries failed persisted tasks without rebuilding the composer or conversation", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/page.tsx"), "utf8");
        const retryStart = source.indexOf("const retryRound");
        const retrySource = source.slice(retryStart, source.indexOf("const adjustQualityReview", retryStart));

        expect(retrySource).toContain("agent.retrySubmission(assistantMessage.id)");
        expect(retrySource).toContain("agent.retryTasks(");
        expect(retrySource).toContain('task.status === "failed" || task.status === "needs_review"');
        expect(retrySource).toContain("retryableTasks.map((task) => task.id)");
        expect(retrySource).toContain("agent.retryRun(run.id)");
        expect(retrySource).not.toContain("updatePrompt");
        expect(retrySource).not.toContain("createCreativeAgentRun");
        expect(retrySource).not.toContain("createCreativeConversation");
    });

    it("restores the original request and references before a user adjusts a quality-blocked result", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/page.tsx"), "utf8");
        const adjustStart = source.indexOf("const adjustQualityReview");
        const adjustSource = source.slice(adjustStart, source.indexOf("const uploadAttachments", adjustStart));

        expect(adjustSource).toContain("updatePrompt(run?.prompt?.trim() || userMessage.content)");
        expect(adjustSource).toContain('agent.restoreAttachments((run?.referencedAssetIds || []).filter((id) => agent.assets.some((asset) => asset.id === id && asset.type === "image")))');
        expect(adjustSource).toContain("inputRef.current?.focus()");
    });

    it("keeps delayed run callbacks and controls scoped to the active conversation", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const watchStart = source.indexOf("const watchRun");
        const reconnectStart = source.indexOf("useEffect(() =>", watchStart);
        const executeStart = source.indexOf("const executeSubmission", reconnectStart);
        const cancelStart = source.indexOf("const cancel", executeStart);
        const controlStart = source.indexOf("const control", cancelStart);

        expect(source.slice(watchStart, reconnectStart)).toContain("if (!isCurrentConversation(run.conversationId, generation)) return false");
        expect(source.slice(reconnectStart, executeStart)).toContain("run.conversationId !== expectedConversationId");
        expect(source.slice(executeStart, cancelStart)).toContain("if (!canClaimCurrentView) return true");
        expect(source.slice(cancelStart, controlStart)).toContain('controlCreativeAgentRun(activeRunId, "cancel", expectedConversationId)');
    });

    it("does not mark a running message as failed when only the event connection stops", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const watchStart = source.indexOf("const watchRun");
        const connectionErrorStart = source.indexOf("onConnectionError:", watchStart);
        const connectionErrorSource = source.slice(connectionErrorStart, source.indexOf("onProjectHandoff:", connectionErrorStart));

        expect(connectionErrorSource).toContain('updateAssistant(assistantMessageId, text, "running")');
        expect(connectionErrorSource).not.toContain('"failed"');
        expect(connectionErrorSource).not.toContain("setActiveRunId(undefined)");
        expect(connectionErrorSource).not.toContain("setActiveRunStatus(undefined)");
    });

    it("keeps the rendered run status synchronized with SSE status updates", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/create/use-create-agent.ts"), "utf8");
        const watchStart = source.indexOf("const watchRun");
        const statusStart = source.indexOf("onStatus:", watchStart);
        const statusSource = source.slice(statusStart, source.indexOf("onTaskCompleted:", statusStart));

        expect(statusSource).toContain("setActiveRunStatus(status)");
        expect(statusSource).toContain("setRunDetails");
        expect(statusSource).toContain("[run.id]");
        expect(statusSource).toContain('status === "paused"');
        expect(statusSource).toContain("getCreativeAgentRun(run.id)");
    });
});
