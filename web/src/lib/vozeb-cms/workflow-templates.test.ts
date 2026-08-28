import { describe, expect, it } from "vitest";

import { validateVozebCmsWorkflowNodes } from "./workflow-contract";
import { createVozebCmsDramaProductionWorkflow } from "./workflow-templates";

describe("VOZEBCMS workflow templates", () => {
    it("defines the complete drama production order", () => {
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one", now: 1 });
        validateVozebCmsWorkflowNodes(workflow.nodes);
        expect(workflow.nodes.map((node) => node.id)).toEqual(["script", "content", "visual", "video", "review", "asset"]);
        expect(workflow.nodes.map((node) => node.config.actionId)).toEqual(["drama.script.require", "drama.content.analyze", "drama.visual.plan", "drama.video.generate", "manual_review", "drama.asset.commit"]);
        expect(workflow.nodes.find((node) => node.id === "review")?.kind).toBe("manual_review");
        expect(workflow.nodes.find((node) => node.id === "video")?.dependsOn).toEqual(["visual"]);
        expect(workflow.nodes.find((node) => node.id === "video")?.config.moduleId).toBe("video");
    });
});
