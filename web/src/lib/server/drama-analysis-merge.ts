import type { DramaContentAnalysis } from "@/lib/drama-project-contract";

export function mergeDramaContentAnalyses(analyses: DramaContentAnalysis[]): DramaContentAnalysis {
    const first = analyses[0];
    return {
        episode: analyses.reduce(
            (episode, analysis) => ({
                outline: episode.outline || analysis.episode.outline,
                hook: episode.hook || analysis.episode.hook,
                nextPreview: episode.nextPreview || analysis.episode.nextPreview,
                sourceRange: episode.sourceRange || analysis.episode.sourceRange,
            }),
            first?.episode || { outline: "", hook: "", nextPreview: "", sourceRange: "" },
        ),
        characters: mergeNamedAssets(analyses.flatMap((analysis) => analysis.characters)),
        scenes: mergeNamedAssets(analyses.flatMap((analysis) => analysis.scenes)),
        props: mergeNamedAssets(analyses.flatMap((analysis) => analysis.props)),
        clues: mergeNamedAssets(analyses.flatMap((analysis) => analysis.clues)),
        shots: analyses.flatMap((analysis) => analysis.shots),
    };
}

function mergeNamedAssets<T extends { name: string }>(items: T[]) {
    const merged = new Map<string, T>();
    for (const item of items) {
        const key = item.name.trim().toLocaleLowerCase();
        if (!key) continue;
        const current = merged.get(key);
        merged.set(key, current ? mergeAsset(current, item) : item);
    }
    return [...merged.values()];
}

function mergeAsset<T extends object>(left: T, right: T): T {
    return Object.fromEntries(Object.entries(left).map(([key, value]) => [key, value || right[key as keyof T]])) as T;
}
