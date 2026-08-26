export function resolveDramaPlannerSnapshot(snapshot: unknown) {
    const source = record(snapshot);
    const episodes = records(source.episodes);
    if (!episodes.length) return source;
    const activeEpisodeId = text(source.activeEpisodeId) || text(source.episodeId);
    const suppliedEpisode = record(source.episode);
    const episode = (text(suppliedEpisode.id) && (!activeEpisodeId || text(suppliedEpisode.id) === activeEpisodeId) ? suppliedEpisode : undefined) || episodes.find((item) => text(item.id) === activeEpisodeId) || episodes[0];
    const project = pick(source, ["id", "title", "summary", "style", "ratio", "status", "activeEpisodeId"]);
    const currentEpisode = pick(episode, ["id", "episodeNumber", "title", "script", "outline", "hook", "nextPreview", "sourceRange", "reviewStatus", "shots", "renderTask", "visualReview"]);
    return {
        ...(text(source.currentStage) ? { currentStage: text(source.currentStage) } : {}),
        project,
        episode: currentEpisode,
        characters: Array.isArray(source.characters) ? source.characters : [],
        scenes: Array.isArray(source.scenes) ? source.scenes : [],
        props: Array.isArray(source.props) ? source.props : [],
        clues: Array.isArray(source.clues) ? source.clues : [],
        ...(Array.isArray(source.currentTurnReferences) ? { currentTurnReferences: source.currentTurnReferences } : {}),
    };
}

function pick(value: Record<string, unknown>, keys: string[]) {
    return Object.fromEntries(keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]] as const])));
}

function records(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
