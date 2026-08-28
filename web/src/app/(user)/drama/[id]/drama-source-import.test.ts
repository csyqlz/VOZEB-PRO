import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("drama source import workspace", () => {
    it("keeps large episode previews bounded and paginated without changing the import pipeline", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-source-import.tsx"), "utf8");
        const editor = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8");

        expect(source).toContain("splitDramaSource(await readDramaSourceFile(file))");
        expect(source).toContain(".docx");
        expect(source).toContain("按章节生成分集");
        expect(source).toContain("file.size > DRAMA_PROJECT_MAX_BYTES");
        expect(source).toContain("new TextEncoder().encode(JSON.stringify(preview)).byteLength > DRAMA_PROJECT_MAX_BYTES");
        expect(source).toContain("请拆分剧本后重新上传");
        expect(source).toContain('createVersion(project, "整本导入前")');
        expect(source).toContain("await importEpisodes(project.id, drafts)");
        expect(source).toContain("IMPORT_PAGE_SIZE = 20");
        expect(source).toContain("data-drama-import-preview");
        expect(source).toContain("<Pagination");
        expect(source).toContain("overflow-y-auto");
        expect(source).toContain("max-h-[min(68vh,640px)]");
        expect(editor.indexOf('await createVersion(project, "AI 内容解析前")')).toBeLessThan(editor.indexOf('fetch("/api/drama/analyze"'));
        expect(editor).toContain("projectId: project.id");
        expect(editor).toContain("episodeId: episode.id");
        expect(editor).toContain('phase: "content"');
        expect(editor).toContain("contentTaskId: taskId");
        expect(editor).toContain("await saveProjectNow(project.id)");
        expect(editor).toContain('contentLifecycle?.status !== "error"');
        expect(editor).toContain("{ contentTaskId: taskId, contentError: detail }");
        expect(editor).toContain("waitForTextGenerationTask(taskConfig");
        expect(editor).toContain("applyDramaVisualResult(project.id, episode.id, taskId, analysis)");
        expect(editor).not.toContain('{ reviewStatus: "approved", visualTaskId: taskId');
        expect(editor).not.toContain("{ visualTaskId: undefined, visualError: detail }");
        expect(editor).toContain('setVisualFailure({ kind: terminal ? "terminal" : "connection", detail })');
    });
});
