"use client";

import { useEffect, useMemo, useState } from "react";

import type { CreativeAgentModelOption } from "@/components/agent/creative-agent-controls";
import type { AgentSkillWorkspace } from "@/lib/auth/store-types";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";
import { modelOptionLabel, selectableModelsByCapability, type AiConfig, useConfigStore } from "@/stores/use-config-store";

export function useCreativeAgentModels(capabilities: CreativeAgentModelOption["capability"][] = ["image", "video", "audio"]) {
    const config = useConfigStore((state) => state.config);
    const capabilityKey = capabilities.join(",");
    return useMemo(() => creativeAgentModelsFromConfig(config, capabilityKey.split(",") as CreativeAgentModelOption["capability"][]), [capabilityKey, config]);
}

export function creativeAgentModelsFromConfig(config: AiConfig, capabilities: CreativeAgentModelOption["capability"][] = ["image", "video", "audio"]) {
    return Array.from(new Set(capabilities)).flatMap((capability) =>
        selectableModelsByCapability(config, capability).map((id) => ({
            id,
            name: modelOptionLabel(config, id),
            capability,
            ...(config.modelPricing[id]
                ? { pricing: config.modelPricing[id] }
                : capability !== "text" && config.modelPointCosts[id] !== undefined
                  ? { pricing: { billingUnit: "per_call" as const, currency: "CNY" as const, salePrice: config.modelPointCosts[id] } }
                  : {}),
        })),
    );
}

export function useCreativeAgentOptions(workspace: AgentSkillWorkspace, capabilities: CreativeAgentModelOption["capability"][] = ["image", "video", "audio"]) {
    const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(true);
    const models = useCreativeAgentModels(capabilities);

    useEffect(() => {
        let active = true;
        setSkillsLoading(true);
        void listAgentSkills(workspace)
            .then((items) => {
                if (active) setSkills(items);
            })
            .catch(() => {
                if (active) setSkills([]);
            })
            .finally(() => {
                if (active) setSkillsLoading(false);
            });
        return () => {
            active = false;
        };
    }, [workspace]);

    return { skills, skillsLoading, models };
}
