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
    if (input.imageUrls.length > 1) throw new Error("OpenAI 视频协议最多支持 1 张参考图");
    const formData = new FormData();
    formData.set("model", input.model);
    formData.set("prompt", input.prompt);
    formData.set("seconds", String(input.seconds));
    if (input.width && input.height) formData.set("size", `${input.width}x${input.height}`);
    if (input.imageUrls[0]) {
        const source = URL.canParse(input.imageUrls[0]) ? new URL(input.imageUrls[0]) : null;
        const imageUrl = source && URL.canParse(input.origin) && source.origin === new URL(input.origin).origin && /^\/api\/(?:reference-assets|generation-log-assets)\//.test(source.pathname) ? `${source.pathname}${source.search}` : input.imageUrls[0];
        const file = await imageReferenceToFile({ dataUrl: imageUrl, url: imageUrl }, "input-reference.png", input.origin, input.cookie);
        formData.set("input_reference", file);
    }
    return formData;
}
