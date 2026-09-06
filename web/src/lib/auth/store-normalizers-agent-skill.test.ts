import { describe, expect, it } from "vitest";

import { normalizeAgentSkill, normalizeAgentSkills } from "./store-normalizers";
import { DEFAULT_SETTINGS } from "./store-foundation";

describe("normalizeAgentSkill", () => {
    it("ships a deduplicated cross-media creative skill catalog", () => {
        const skills = DEFAULT_SETTINGS.agentSkills;
        const ids = skills.map((skill) => skill.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining(["brand-content-system", "social-content", "storyboard-shot", "product-campaign", "brand-visual-system", "product-photo-edit", "style-consistency"]));
        for (const skill of skills) {
            expect(skill.description.length).toBeGreaterThan(0);
            expect(skill.instructions.length).toBeGreaterThan(0);
            expect(skill.workspaces?.length).toBeGreaterThan(0);
        }
    });

    it("derives a zero-configuration planner summary and preserves full execution instructions", () => {
        const instructions = "完整执行规则".repeat(100);
        const skill = normalizeAgentSkill({ id: "skill", name: "技能", description: "用于规划的简要用途", instructions, enabled: true, keywords: [] });

        expect(skill.plannerSummary).toBe("用于规划的简要用途");
        expect(skill.instructions).toBe(instructions);
    });

    it("collapses duplicate ids from imported settings while merging coverage", () => {
        const skills = normalizeAgentSkills([
            { id: "duplicate", name: "重复能力", description: "图片能力", instructions: "图片规则", enabled: true, keywords: ["图片"], workspaces: ["image"] },
            { id: "duplicate", name: "重复能力", description: "视频能力", instructions: "视频规则", enabled: true, keywords: ["视频"], workspaces: ["video"] },
        ]);
        const duplicate = skills.filter((skill) => skill.id === "duplicate");
        expect(duplicate).toHaveLength(1);
        expect(duplicate[0]?.workspaces).toEqual(["image", "video"]);
        expect(duplicate[0]?.keywords).toEqual(["图片", "视频"]);
    });

    it("limits an explicit planner summary to 240 characters", () => {
        const skill = normalizeAgentSkill({ id: "skill", name: "技能", description: "", plannerSummary: "a".repeat(300), instructions: "执行", enabled: true, keywords: [] });

        expect(skill.plannerSummary).toHaveLength(240);
    });

    it("preserves normalized GitHub provenance across settings persistence", () => {
        const skill = normalizeAgentSkill({
            id: "github-skill",
            name: "公开 Skill",
            description: "公开说明",
            instructions: "完整执行规则",
            enabled: false,
            keywords: [],
            sourceUrl: " https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md ",
            sourceRepository: " acme/skills ",
            sourcePath: " poster/SKILL.md ",
            sourceVersion: " 0123456789abcdef0123456789abcdef01234567 ",
            sourceCommit: " 0123456789abcdef0123456789abcdef01234567 ",
            sourceContentHash: ` ${"a".repeat(64)} `,
            license: " MIT ",
        });

        expect(skill).toMatchObject({
            enabled: false,
            sourceUrl: "https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md",
            sourceRepository: "acme/skills",
            sourcePath: "poster/SKILL.md",
            sourceVersion: "0123456789abcdef0123456789abcdef01234567",
            sourceCommit: "0123456789abcdef0123456789abcdef01234567",
            sourceContentHash: "a".repeat(64),
            license: "MIT",
        });
    });
});
