import { createHash } from "node:crypto";

import type { DramaContentAnalysis, DramaNamedAsset, DramaProject, DramaShot, DramaShotContinuity, DramaVisualAnalysis } from "@/lib/drama-project-contract";

export function applyDramaContentAnalysisToProject(project: DramaProject, episodeId: string, analysis: DramaContentAnalysis): DramaProject {
    const characters = mergeNamedAssets(project.characters, analysis.characters, "character");
    const scenes = mergeNamedAssets(project.scenes, analysis.scenes, "scene");
    const props = mergeNamedAssets(project.props, analysis.props, "prop");
    const clues = mergeNamedAssets(project.clues, analysis.clues, "clue");
    const ids = {
        characters: assetIds(characters),
        scenes: assetIds(scenes),
        props: assetIds(props),
        clues: assetIds(clues),
    };
    return {
        ...project,
        characters,
        scenes,
        props,
        clues,
        episodes: project.episodes.map((episode) =>
            episode.id !== episodeId
                ? episode
                : {
                      ...episode,
                      ...analysis.episode,
                      reviewStatus: "content_review",
                      renderTask: undefined,
                      shots: analysis.shots.map((shot, index) => ({
                          id: stableAnalysisId("shot", episodeId, `${index}:${shot.sourceText}:${shot.title}`),
                          order: index + 1,
                          title: shot.title,
                          description: shot.description,
                          sourceText: shot.sourceText,
                          shotBoundary: shot.shotBoundary,
                          dialogue: shot.dialogue,
                          narration: shot.narration,
                          utterances: shot.utterances,
                          subtitle: [shot.dialogue, shot.narration].filter(Boolean).join("\n"),
                          imagePrompt: "",
                          videoPrompt: "",
                          cameraMotion: "",
                          startFramePrompt: "",
                          endFramePrompt: "",
                          negativePrompt: "",
                          continuity: emptyContinuity(),
                          duration: shot.duration,
                          characterIds: resolveNames(shot.characterNames, ids.characters),
                          sceneId: ids.scenes.get(normalizeName(shot.sceneName)),
                          propIds: resolveNames(shot.propNames, ids.props),
                          clueIds: resolveNames(shot.clueNames, ids.clues),
                          videoMode: project.defaultVideoMode,
                          imageModel: project.imageModel,
                          storyboardFrameMode: "single",
                          storyboardStatus: "idle",
                          generationStatus: "idle",
                          audioMode: "source",
                          audioStatus: "idle",
                      })),
                  },
        ),
    };
}

export function applyDramaVisualAnalysisToProject(project: DramaProject, episodeId: string, analysis: DramaVisualAnalysis): DramaProject {
    const visualByShot = new Map(analysis.shots.map((shot) => [shot.shotId, shot]));
    return {
        ...project,
        episodes: project.episodes.map((episode) =>
            episode.id !== episodeId
                ? episode
                : {
                      ...episode,
                      reviewStatus: "visual_ready",
                      visualError: undefined,
                      shots: episode.shots.map((shot) => {
                          const visual = visualByShot.get(shot.id);
                          return visual
                              ? {
                                    ...shot,
                                    imagePrompt: visual.imagePrompt,
                                    videoPrompt: visual.videoPrompt,
                                    cameraMotion: visual.cameraMotion,
                                    startFramePrompt: visual.startFramePrompt,
                                    endFramePrompt: visual.endFramePrompt,
                                    negativePrompt: visual.negativePrompt,
                                    continuity: visual.continuity,
                                }
                              : shot;
                      }),
                  },
        ),
    };
}

function mergeNamedAssets<T extends DramaNamedAsset>(existing: T[], incoming: Array<Omit<T, "id">>, prefix: string): T[] {
    const items = existing.map((item) => ({ ...item }));
    for (const item of incoming) {
        const name = normalizeName(item.name);
        if (!name) continue;
        const index = items.findIndex((current) => normalizeName(current.name) === name);
        if (index >= 0) items[index] = { ...items[index], ...item, id: items[index].id };
        else items.push({ ...item, id: stableAnalysisId(prefix, prefix, name) } as T);
    }
    return items;
}

function assetIds(items: DramaNamedAsset[]) {
    return new Map(items.map((item) => [normalizeName(item.name), item.id]));
}

function resolveNames(names: string[], ids: Map<string, string>) {
    return names.map((name) => ids.get(normalizeName(name))).filter((id): id is string => Boolean(id));
}

function stableAnalysisId(prefix: string, scope: string, value: string) {
    return `${prefix}-analysis-${createHash("sha256").update(`${scope}\0${value}`).digest("hex").slice(0, 16)}`;
}

function normalizeName(value: string) {
    return value.trim().toLocaleLowerCase();
}

function emptyContinuity(): DramaShotContinuity {
    return { shotSize: "", cameraAngle: "", composition: "", characterBlocking: "", gazeDirection: "", actionStart: "", actionEnd: "", screenDirection: "", axisRule: "", continuityNotes: "" };
}

export function updateDramaShotTask(project: DramaProject, episodeId: string, shotId: string, patch: Partial<DramaShot>): DramaProject {
    return {
        ...project,
        episodes: project.episodes.map((episode) => (episode.id === episodeId ? { ...episode, shots: episode.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)) } : episode)),
    };
}
