import { imageReferenceToFile } from "@/app/api/image-tasks/image-task-support";

type OpenAiVideoFormInput = {
    model: string;
    prompt: string;
    seconds: number;
    width?: number;
    height?: number;
    imageUrls: string[];
    origin: string;
    cookie: string;
};

export async function buildOpenAiVideoFormData(input: OpenAiVideoFormInput) {
    assertOpenAiVideoImageReferences(input.imageUrls);
    const formData = new FormData();
    formData.set("model", input.model);
    formData.set("prompt", input.prompt);
    formData.set("seconds", String(input.seconds));
    if (input.width && input.height) formData.set("size", `${input.width}x${input.height}`);
    if (input.imageUrls[0]) {
        const file = await imageReferenceToFile({ dataUrl: input.imageUrls[0], url: input.imageUrls[0] }, "input-reference.png", input.origin, input.cookie);
        formData.set("input_reference", file);
    }
    return formData;
}

export function assertOpenAiVideoImageReferences(imageUrls: string[]) {
    if (imageUrls.length > 1) throw new Error("OpenAI 视频协议最多支持 1 张参考图");
}
