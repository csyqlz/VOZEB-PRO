import type { OfficialPriceSource } from "./types";

export const DEFAULT_OFFICIAL_PRICE_SOURCES: OfficialPriceSource[] = [
    { manufacturer: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing", updatedAt: null },
    { manufacturer: "Anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing", updatedAt: null },
    { manufacturer: "OpenAI", url: "https://developers.openai.com/api/docs/pricing", updatedAt: null },
    { manufacturer: "xAI", url: "https://docs.x.ai/developers/pricing", updatedAt: null },
    { manufacturer: "DeepSeek", url: "https://api-docs.deepseek.com/quick_start/pricing/", updatedAt: null },
    { manufacturer: "ByteDance / Volcengine", url: "https://docs.byteplus.com/en/docs/modelark/model-pricing", updatedAt: null },
    { manufacturer: "Alibaba Cloud", url: "https://www.alibabacloud.com/help/en/model-studio/model-pricing", updatedAt: null },
    { manufacturer: "Moonshot", url: "https://platform.kimi.ai/docs/pricing/chat", updatedAt: null },
    { manufacturer: "MiniMax", url: "https://platform.minimax.io/docs/pricing/overview", updatedAt: null },
    { manufacturer: "Zhipu", url: "https://docs.z.ai/guides/overview/pricing", updatedAt: null },
    { manufacturer: "Xiaomi", url: "https://mimo.mi.com/docs/en-US/price/pay-as-you-go", updatedAt: null },
    { manufacturer: "Black Forest Labs", url: "https://bfl.ai/pricing", updatedAt: null },
    { manufacturer: "Kuaishou / Kling", url: "https://kling.ai/document-api/pricing/base/video", updatedAt: null },
    { manufacturer: "Shengshu / Vidu", url: "https://platform.vidu.com/pricing", updatedAt: null },
];
