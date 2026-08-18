export function toStoryAssetKind(kind: "character" | "scene" | "prop") {
  return kind === "character" ? "characters" : kind === "scene" ? "scenes" : "props";
}

export function buildStoryAssetPayload(input: {
  kind: "character" | "scene" | "prop";
  name: string;
  description: string;
  imageUrl: string;
}) {
  return {
    bucket: toStoryAssetKind(input.kind),
    item: {
      name: input.name,
      description: input.description,
      imageUrl: input.imageUrl,
    },
  };
}
