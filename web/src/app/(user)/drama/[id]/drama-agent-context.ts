import type { AgentMediaDownload } from "@/components/agent/agent-media-download";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { DramaEpisode, DramaNamedAsset, DramaProject } from "@/lib/drama-project-contract";
import type { DramaAgentMentionItem } from "./drama-agent-mention";
import type { DramaProjectStage } from "./drama-project-sections";

export const DRAMA_AGENT_STAGE_GUIDES: Record<DramaProjectStage, { label: string; prompts: Array<{ label: string; prompt: string }> }> = {
    script: {
        label: "剧本协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集剧本是否具备进入内容审核的条件，按已完成、待补充、阻塞项列出结果。" },
            { label: "检查缺失资产", prompt: "从当前剧本中找出尚未登记的角色、场景、道具和线索，只给出资产清单与优先级。" },
            { label: "检查一致性", prompt: "检查当前集的人物动机、时间线、冲突、情绪递进和结尾钩子是否一致，列出最小修改建议。" },
            { label: "建议下一步", prompt: "根据当前剧本与项目状态，只建议一个最值得立即执行的下一步，并说明完成标准。" },
        ],
    },
    review: {
        label: "内容审核协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前内容审核是否具备确认条件，按镜头列出已完成、待确认和阻塞项。" },
            { label: "检查缺失资产", prompt: "检查审核结果是否遗漏角色、场景、道具、线索或对应稳定引用，列出缺失项。" },
            { label: "检查一致性", prompt: "核对镜头与原剧本的对白、旁白、角色、场景、道具、线索和镜头边界，列出不一致项。" },
            { label: "建议下一步", prompt: "根据当前审核状态，只建议一个最值得立即执行的下一步，并说明完成标准。" },
        ],
    },
    storyboard: {
        label: "分镜协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集分镜是否具备进入镜头生成的条件，按镜头列出完成、待补和阻塞项。" },
            { label: "检查缺失资产", prompt: "检查分镜图片与视频提示词是否缺少稳定角色、场景、道具、线索或参考图引用。" },
            { label: "检查一致性", prompt: "检查当前集分镜的景别、轴线、视线、动作承接、场景连续性和资产一致性，给出逐镜头建议。" },
            { label: "建议下一步", prompt: "根据当前分镜状态，只建议一个最值得立即修正的镜头，并说明完成标准。" },
        ],
    },
    generate: {
        label: "生成协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集镜头、配音与整集合成的完成度，按可生成、生成中、失败和已完成分类。" },
            { label: "检查缺失资产", prompt: "检查待生成镜头的提示词、参考资产、画幅、时长、首尾帧和配音依赖是否完整。" },
            { label: "检查一致性", prompt: "检查当前生成结果的角色、场景、动作、镜头衔接、音画与字幕一致性，归纳需修正项。" },
            { label: "建议下一步", prompt: "根据当前任务状态与错误信息，只建议一个最值得立即执行的下一步，不自动重试或生成。" },
        ],
    },
};

function agentAssetSnapshot(asset: DramaNamedAsset) {
    return {
        id: asset.id,
        name: asset.name,
        description: asset.description,
        profile: asset.profile,
        primaryReferenceId: asset.primaryReferenceId,
        referenceImageUrl: asset.referenceImageUrl,
    };
}

export function dramaSnapshot(project: DramaProject, episode: DramaEpisode, stage: DramaProjectStage, selectedShotId?: string, projectReferences: DramaAgentMentionItem[] = []) {
    return {
        currentStage: stage,
        project: {
            id: project.id,
            title: project.title,
            summary: project.summary,
            style: project.style,
            ratio: project.ratio,
            defaultVideoMode: project.defaultVideoMode,
        },
        episode: {
            id: episode.id,
            title: episode.title,
            script: episode.script,
            outline: episode.outline,
            hook: episode.hook,
            nextPreview: episode.nextPreview,
            sourceRange: episode.sourceRange,
            reviewStatus: episode.reviewStatus,
        },
        selectedShotId,
        currentTurnReferences: projectReferences.map(({ id, kind, title, alias }) => ({ id, kind, title, alias: `@${alias}` })),
        sourceAssets: project.sourceAssets?.map((asset) => ({
            id: asset.id,
            type: asset.type,
            title: asset.title,
            textContent: asset.textContent,
            serverUrl: asset.serverUrl,
            remoteUrl: asset.remoteUrl,
        })),
        characters: project.characters.map((asset) => ({ ...agentAssetSnapshot(asset), voiceProfile: asset.voiceProfile })),
        scenes: project.scenes.map(agentAssetSnapshot),
        props: project.props.map(agentAssetSnapshot),
        clues: project.clues.map((asset) => ({ ...agentAssetSnapshot(asset), payoff: asset.payoff })),
        shots: episode.shots.map((shot) => ({
            id: shot.id,
            order: shot.order,
            title: shot.title,
            description: shot.description,
            sourceText: shot.sourceText,
            shotBoundary: shot.shotBoundary,
            dialogue: shot.dialogue,
            narration: shot.narration,
            utterances: shot.utterances,
            imagePrompt: shot.imagePrompt,
            videoPrompt: shot.videoPrompt,
            cameraMotion: shot.cameraMotion,
            startFramePrompt: shot.startFramePrompt,
            endFramePrompt: shot.endFramePrompt,
            negativePrompt: shot.negativePrompt,
            continuity: shot.continuity,
            duration: shot.duration,
            characterIds: shot.characterIds,
            sceneId: shot.sceneId,
            propIds: shot.propIds,
            clueIds: shot.clueIds,
            videoMode: shot.videoMode,
            storyboardFrameMode: shot.storyboardFrameMode,
            storyboardStatus: shot.storyboardStatus,
            storyboardError: shot.storyboardError,
            storyboardImageUrl: shot.storyboardImageUrl,
            storyboardImageStorageKey: shot.storyboardImageStorageKey,
            storyboardEndStatus: shot.storyboardEndStatus,
            storyboardEndError: shot.storyboardEndError,
            storyboardEndImageUrl: shot.storyboardEndImageUrl,
            storyboardEndImageStorageKey: shot.storyboardEndImageStorageKey,
            generationStatus: shot.generationStatus,
            generationError: shot.generationError,
            videoUrl: shot.videoUrl,
            videoStorageKey: shot.videoStorageKey,
            subtitle: shot.subtitle,
            audioMode: shot.audioMode,
            audioStatus: shot.audioStatus,
            audioError: shot.audioError,
            audioUrl: shot.audioUrl,
            audioStorageKey: shot.audioStorageKey,
        })),
    };
}

export function agentAssetDownloads(assets: CreativeAsset[]): AgentMediaDownload[] {
    return assets.flatMap((asset) => {
        const url = asset.serverUrl || asset.remoteUrl || "";
        return url && (asset.type === "image" || asset.type === "video") ? [{ type: asset.type, url, title: asset.title || (asset.type === "video" ? "生成视频" : "生成图片"), mimeType: asset.mimeType }] : [];
    });
}
