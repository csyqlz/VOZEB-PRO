import { GoogleAuth } from "google-auth-library";

import type { SystemChannelAuthMode } from "@/lib/auth/store-types";

type AccessTokenLoader = () => Promise<string | null | undefined>;

let googleAuth: GoogleAuth | undefined;

export async function gcpAgentPlatformAuthHeaders(apiKey: string, authMode: SystemChannelAuthMode | undefined, accessToken: AccessTokenLoader = loadGoogleAccessToken): Promise<Record<string, string>> {
    if (authMode === "custom-header") {
        const key = apiKey.trim();
        if (!key) throw new Error("GCP Agent Platform API Key 未配置");
        return { "x-goog-api-key": key };
    }
    if (authMode !== "google-adc") throw new Error("GCP Agent Platform 鉴权方式无效");
    const token = (await accessToken())?.trim() || "";
    if (!token) throw new Error("GCP Agent Platform ADC 不可用");
    return { authorization: `Bearer ${token}` };
}

async function loadGoogleAccessToken() {
    googleAuth ||= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    return googleAuth.getAccessToken();
}
