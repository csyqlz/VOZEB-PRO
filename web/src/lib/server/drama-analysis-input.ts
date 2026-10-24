import { resolveDramaShotDuration } from "@/lib/server/drama-shot-config";

export type DramaAnalyzeBody = {
    requestId?: string;
    projectId?: string;
    phase?: "content" | "visual";
    script?: string;
    summary?: string;
    style?: string;
    videoModel?: string;
    episode?: unknown;
    characters?: unknown;
    scenes?: unknown;
    props?: unknown;
    clues?: unknown;
    shots?: unknown;
};

export function dramaAnalysisText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeDramaVisualInput(body: DramaAnalyzeBody) {
    const shots = array(body.shots).flatMap((value) => {
        const shot = object(value);
        const id = dramaAnalysisText(shot.id);
        if (!id) return [];
        const utterances = normalizeUtterances(shot.utterances);
        return [
            {
                id,
                title: dramaAnalysisText(shot.title),
                description: dramaAnalysisText(shot.description),
                sourceText: dramaAnalysisText(shot.sourceText),
                shotBoundary: dramaAnalysisText(shot.shotBoundary),
                utterances,
                duration: resolveDramaShotDuration(shot.duration, 5),
                characterIds: texts(shot.characterIds),
                sceneId: dramaAnalysisText(shot.sceneId),
                propIds: texts(shot.propIds),
                clueIds: texts(shot.clueIds),
            },
        ];
    });
    const referenced = referencedAssetIds(shots);
    return {
        shotIds: shots.map((shot) => shot.id),
        payload: {
            project: { summary: dramaAnalysisText(body.summary), style: dramaAnalysisText(body.style) },
            episode: normalizeEpisode(body.episode),
            assets: {
                characters: normalizeVisualAssets(body.characters, referenced.characters),
                scenes: normalizeVisualAssets(body.scenes, referenced.scenes),
                props: normalizeVisualAssets(body.props, referenced.props),
                clues: normalizeVisualAssets(body.clues, referenced.clues),
            },
            shots,
        },
    };
}

export type NormalizedDramaVisualInput = ReturnType<typeof normalizeDramaVisualInput>;

export function selectDramaVisualInput(input: NormalizedDramaVisualInput, shotIds: string[]): NormalizedDramaVisualInput {
    const allowed = new Set(shotIds);
    const shots = input.payload.shots.filter((shot) => allowed.has(shot.id));
    const referenced = referencedAssetIds(shots);
    return {
        shotIds: shots.map((shot) => shot.id),
        payload: {
            ...input.payload,
            assets: {
                characters: input.payload.assets.characters.filter((asset) => referenced.characters.has(asset.id)),
                scenes: input.payload.assets.scenes.filter((asset) => referenced.scenes.has(asset.id)),
                props: input.payload.assets.props.filter((asset) => referenced.props.has(asset.id)),
                clues: input.payload.assets.clues.filter((asset) => referenced.clues.has(asset.id)),
            },
            shots,
        },
    };
}

function normalizeVisualAssets(value: unknown, referencedIds: Set<string>) {
    return array(value).flatMap((item) => {
        const asset = object(item);
        const id = dramaAnalysisText(asset.id);
        const name = dramaAnalysisText(asset.name);
        if (!id || !name || !referencedIds.has(id)) return [];
        const profile = object(asset.profile);
        return [
            {
                id,
                name,
                description: dramaAnalysisText(asset.description),
                profile: {
                    visualIdentity: dramaAnalysisText(profile.visualIdentity),
                    styling: dramaAnalysisText(profile.styling),
                    colorPalette: dramaAnalysisText(profile.colorPalette),
                    consistencyRules: dramaAnalysisText(profile.consistencyRules),
                },
                payoff: dramaAnalysisText(asset.payoff),
            },
        ];
    });
}

function normalizeEpisode(value: unknown) {
    const episode = object(value);
    return {
        id: dramaAnalysisText(episode.id),
        title: dramaAnalysisText(episode.title),
        outline: dramaAnalysisText(episode.outline),
        hook: dramaAnalysisText(episode.hook),
        nextPreview: dramaAnalysisText(episode.nextPreview),
        sourceRange: dramaAnalysisText(episode.sourceRange),
    };
}

function referencedAssetIds(shots: Array<{ characterIds: string[]; sceneId: string; propIds: string[]; clueIds: string[] }>) {
    return {
        characters: new Set(shots.flatMap((shot) => shot.characterIds)),
        scenes: new Set(shots.map((shot) => shot.sceneId).filter(Boolean)),
        props: new Set(shots.flatMap((shot) => shot.propIds)),
        clues: new Set(shots.flatMap((shot) => shot.clueIds)),
    };
}

function normalizeUtterances(value: unknown) {
    return array(value).flatMap((item, index) => {
        const utterance = object(item);
        const text = dramaAnalysisText(utterance.text);
        if (!text) return [];
        return [
            {
                id: dramaAnalysisText(utterance.id),
                order: Math.max(1, Math.floor(Number(utterance.order) || index + 1)),
                type: utterance.type === "voiceover" ? "voiceover" : "dialogue",
                speaker: dramaAnalysisText(utterance.speaker),
                text,
            },
        ];
    });
}

function texts(value: unknown) {
    return array(value).map(dramaAnalysisText).filter(Boolean);
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
