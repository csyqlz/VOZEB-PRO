"use client";

import { useEffect, useMemo, useState } from "react";

import type { CreativeAgentModelOption } from "@/components/agent/creative-agent-controls";
import type { AgentSkillWorkspace } from "@/lib/auth/store-types";
import { listAgentSkills, type AgentSkillSummary } from "@/services/api/agent-skills";
import { modelOptionLabel, selectableModelsByCapability, type AiConfig, useConfigStore } from "@/stores/use-config-store";
import { creativeModelProfileForLogicalModel } from "@/lib/creative-model-capabilities";

export function useCreativeAgentModels(capabilities: CreativeAgentModelOption["capability"][] = ["image", "video", "audio"]) {
    const config = useConfigStore((state) => state.config);
    const capabilityKey = capabilities.join(",");
    return useMemo(() => creativeAgentModelsFromConfig(config, capabilityKey.split(",") as CreativeAgentModelOption["capability"][]), [capabilityKey, config]);
}

export function creativeAgentModelsFromConfig(config: AiConfig, capabilities: CreativeAgentModelOption["capability"][] = ["image", "video", "audio"]) {
    return Array.from(new Set(capabilities)).flatMap((capability) =>
        selectableModelsByCapability(config, capability).map((id) => {
            const logical = config.logicalModels.find((model) => model.id.toLowerCase() === id.toLowerCase());
            const capabilityProfile = creativeModelProfileForLogicalModel(logical);
            return { id, name: modelOptionLabel(config, id), capability, ...(capabilityProfile ? { capabilityProfile } : {}) };
        }),
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
