import { AuthInputError } from "./store";
import { readRequestBodyText, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

const DEFAULT_JSON_BODY_BYTES = 4 * 1024 * 1024;

export async function readJsonBody<T>(request: Request, maxBytes = DEFAULT_JSON_BODY_BYTES) {
    try {
        const text = await readRequestBodyText(request, maxBytes);
        return (text.trim() ? JSON.parse(text) : {}) as T;
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
            const inputError = new AuthInputError(error.message);
            inputError.status = error.status;
            throw inputError;
        }
        throw new AuthInputError("请求内容不是有效 JSON");
    }
}

export async function readJsonObjectBody(request: Request, maxBytes = DEFAULT_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
    const value = await readJsonBody<unknown>(request, maxBytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthInputError("请求内容必须是 JSON 对象");
    return value as Record<string, unknown>;
}

export async function readJsonBodyResult<T>(request: Request, maxBytes = DEFAULT_JSON_BODY_BYTES) {
    try {
        return { ok: true, data: await readJsonBody<T>(request, maxBytes) } as const;
    } catch (error) {
        if (error instanceof AuthInputError) return { ok: false, status: error.status, message: error.message } as const;
        throw error;
    }
}
