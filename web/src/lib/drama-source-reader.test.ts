import { describe, expect, it, vi } from "vitest";

import { extractWordDocumentText, isDocxFile } from "./drama-source-reader";

describe("drama source reader", () => {
    it("recognizes docx files by MIME type or extension", () => {
        expect(isDocxFile({ name: "小说.docx", type: "" })).toBe(true);
        expect(isDocxFile({ name: "小说.bin", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(true);
        expect(isDocxFile({ name: "小说.txt", type: "text/plain" })).toBe(false);
    });

    it("reads Word paragraphs, tabs and line breaks through the browser XML parser", () => {
        const text = (value: string) => ({ nodeType: 1, localName: "t", textContent: value, childNodes: [] });
        const element = (localName: string, childNodes: unknown[] = []) => ({ nodeType: 1, localName, textContent: null, childNodes });
        const paragraphs = [element("p", [element("r", [text("第一章 归来")])]), element("p", [element("r", [text("甲"), element("tab"), text("乙"), element("br"), text("丙")])])];
        vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
        vi.stubGlobal(
            "DOMParser",
            class {
                parseFromString() {
                    return { querySelector: () => null, getElementsByTagNameNS: () => paragraphs };
                }
            },
        );

        try {
            expect(extractWordDocumentText("<w:document />")).toBe("第一章 归来\n甲\t乙\n丙");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
