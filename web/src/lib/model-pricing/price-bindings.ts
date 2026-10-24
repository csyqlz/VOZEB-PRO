import { PricingInputError } from "./primitives";
import type { ModelPriceBinding } from "./types";

const operations: Record<ModelPriceBinding["capability"], readonly ModelPriceBinding["operation"][]> = {
    text: ["generation"],
    image: ["generations", "edits"],
    video: ["generation"],
    audio: ["generateContent", "chat/completions"],
};

export function modelPriceBindingScope(capability: ModelPriceBinding["capability"], operation: string, processingMode: string): string {
    if (!operations[capability]?.includes(operation as ModelPriceBinding["operation"])) throw new PricingInputError("选价操作不属于已注册的模型能力");
    if (!["standard", "batch", "flex", "fast", "ultrafast"].includes(processingMode)) throw new PricingInputError("选价处理档位无效");
    return `${capability}:${operation}:${processingMode}`;
}
