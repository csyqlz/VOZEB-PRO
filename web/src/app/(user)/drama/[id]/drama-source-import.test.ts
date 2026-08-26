import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("drama source import workspace", () => {
    it("keeps large episode previews bounded and paginated without changing the import pipeline", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-source-import.tsx"), "utf8");

        expect(source).toContain("splitDramaSource(await readDramaSourceFile(file))");
        expect(source).toContain(".docx");
        expect(source).toContain("按章节生成分集");
        expect(source).toContain('createVersion(project, "整本导入前")');
        expect(source).toContain("importEpisodes(project.id, drafts)");
        expect(source).toContain("IMPORT_PAGE_SIZE = 20");
        expect(source).toContain("data-drama-import-preview");
        expect(source).toContain("<Pagination");
        expect(source).toContain("overflow-y-auto");
        expect(source).toContain("max-h-[min(68vh,640px)]");
    });
});
