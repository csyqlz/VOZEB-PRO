import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ imageReferenceToFile: vi.fn() }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({ imageReferenceToFile: mocks.imageReferenceToFile }));

import { buildOpenAiVideoFormData } from "./video-task-openai";

describe("OpenAI video reference uploads", () => {
    beforeEach(() => {
        mocks.imageReferenceToFile.mockReset().mockResolvedValue(new File(["image"], "input-reference.png", { type: "image/png" }));
    });

    it("reads a signed same-origin managed image through the internal media route", async () => {
        const signed = "http://127.0.0.1:3100/api/generation-log-assets/example.png?purpose=input&signature=test";
        const form = await buildOpenAiVideoFormData({ model: "e2e-video", prompt: "test", seconds: 5, imageUrls: [signed], origin: "http://127.0.0.1:3100", cookie: "session=test" });
        expect(mocks.imageReferenceToFile).toHaveBeenCalledWith(
            { dataUrl: "/api/generation-log-assets/example.png?purpose=input&signature=test", url: "/api/generation-log-assets/example.png?purpose=input&signature=test" },
            "input-reference.png",
            "http://127.0.0.1:3100",
            "session=test",
        );
        expect(form.get("input_reference")).toBeInstanceOf(File);
    });

    it("leaves external references on the outbound validation path", async () => {
        const external = "https://media.example.com/reference.png";
        await buildOpenAiVideoFormData({ model: "e2e-video", prompt: "test", seconds: 5, imageUrls: [external], origin: "http://127.0.0.1:3100", cookie: "" });
        expect(mocks.imageReferenceToFile).toHaveBeenCalledWith({ dataUrl: external, url: external }, "input-reference.png", "http://127.0.0.1:3100", "");
    });

    it("keeps inline images when no site origin is configured", async () => {
        const inline = "data:image/png;base64,aW1hZ2U=";
        await buildOpenAiVideoFormData({ model: "e2e-video", prompt: "test", seconds: 5, imageUrls: [inline], origin: "", cookie: "" });
        expect(mocks.imageReferenceToFile).toHaveBeenCalledWith({ dataUrl: inline, url: inline }, "input-reference.png", "", "");
    });
});
