export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: readonly unknown[]) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    const multiReferenceRule =
        references.length > 1
            ? `\n\n多图合成规则：这是一次多参考图合成任务，请将所有参考图作为独立素材共同参与同一张最终结果图。严格按用户对图片编号的分工处理（例如“图片1作背景、图片2提供文字、图片3提供人物”），保留每张图被指定的主体、文字、布局或风格，不要只使用第一张图；如果用户没有明确分工，也要综合全部参考图并避免遗漏。`
            : "";
    return `Reference images: ${labels.join(", ")}. Use the reference image as real visual input, not as a text description. If a reference image contains a person or character, keep the same identity/character, face proportions, hairstyle, body shape, clothing, and main pose as much as possible. Only change the scene, style, background, or details requested by the user. Do not replace the referenced person with a new person.${multiReferenceRule}\n\n参考图片编号：${labels.join("、")}。如果参考图中包含人物或角色，请保持同一人物/角色、五官比例、发型、体型、服饰和主要姿态，只按用户要求修改场景、风格、背景或细节，不要换成新人物。${references.length > 1 ? "多张参考图必须合成为一张最终图，并按用户对图片编号的分工分别取用，不能只读取第一张。" : ""}\n\n${text}`;
}
