"use client";

import { Input, Segmented } from "antd";

import { LabeledControl } from "@/components/admin/admin-settings-controls";
import type { SystemModelChannel } from "@/lib/auth/store";
import { gcpAgentPlatformBaseUrl, isValidGcpLocation } from "@/lib/gcp-agent-platform";

export function GcpAgentPlatformFields({ channel, onChange }: { channel: SystemModelChannel; onChange: (patch: Partial<SystemModelChannel>) => void }) {
    const advanced = channel.advancedConfig!;
    const credentialMode = advanced.authMode === "custom-header" ? "api-key" : "adc";
    const location = (advanced.gcpLocation || "global").trim().toLowerCase();
    const endpoint = isValidGcpLocation(location) ? gcpAgentPlatformBaseUrl(location) : "";
    const updateAdvanced = (patch: Partial<NonNullable<SystemModelChannel["advancedConfig"]>>) => onChange({ advancedConfig: { ...advanced, ...patch } });
    const updateLocation = (value: string) => {
        const location = value.trim().toLowerCase();
        onChange({
            baseUrl: isValidGcpLocation(location) ? gcpAgentPlatformBaseUrl(location) : "",
            advancedConfig: { ...advanced, gcpLocation: location },
        });
    };

    return (
        <>
            <LabeledControl label="GCP Project ID">
                <Input value={advanced.gcpProjectId || ""} placeholder="my-google-cloud-project" onChange={(event) => updateAdvanced({ gcpProjectId: event.target.value.trim().toLowerCase() })} />
            </LabeledControl>
            <LabeledControl label="Location">
                <Input value={advanced.gcpLocation || "global"} placeholder="global / asia-east1" onChange={(event) => updateLocation(event.target.value)} />
            </LabeledControl>
            <LabeledControl label="鉴权方式">
                <Segmented
                    block
                    value={credentialMode}
                    options={[
                        { label: "ADC", value: "adc" },
                        { label: "API Key", value: "api-key" },
                    ]}
                    onChange={(value) =>
                        onChange({
                            ...(value === "adc" ? { apiKey: "", clearApiKey: true } : { clearApiKey: false }),
                            advancedConfig: { ...advanced, authMode: value === "api-key" ? "custom-header" : "google-adc", authHeader: "", authPrefix: "" },
                        })
                    }
                />
            </LabeledControl>
            <LabeledControl label="服务端 Endpoint">
                <Input value={endpoint} readOnly />
            </LabeledControl>
        </>
    );
}
