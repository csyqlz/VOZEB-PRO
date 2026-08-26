export const YANAI_BEAUTY_SKILL = {
    id: "yanai-natural-beauty",
    name: "自然美颜精修",
    description: "保留本人身份和真实肤质的自然人像精修。",
    sourceUrl: "https://github.com/huaiyuechusan/YanAI",
    sourceVersion: "2026-05-27",
    license: "MIT",
    enabled: true,
    workspaces: ["image", "canvas"],
    action: "edit",
    requiresReference: true,
    defaultConfig: { quality: "high", count: 1 },
    keywords: ["美颜", "精修", "人像", "皮肤", "肤色", "磨皮", "照片修复", "自然美颜", "写真"],
    instructions: `基于 huaiyuechusan/YanAI 默认提示词库中的“自然美颜精修”工作流适配（MIT）。必须要求用户提供人像参考图，并使用图片编辑模式。
严格保留同一人的身份相似度、五官结构、脸型比例、年龄感、发型轮廓、表情、服装、背景和原始构图。不得换脸、瘦脸、改变眼鼻嘴形状或制造网红脸。
优化顺序：轻微均匀肤色，降低暗沉、泛红和油光；只去除临时瑕疵、痘印、浮粉和明显斑驳；保留毛孔、细纹、绒毛和真实皮肤纹理；轻微提亮眼神和面部重点区域，保持自然高光与阴影；增强眉毛、睫毛、嘴唇和发丝的清晰度但不重画五官或增加浓妆；修正白平衡、曝光和对比度，使画面通透自然。
彻底避免塑料皮肤、蜡像感、过度磨皮、假毛孔、过锐化、重 HDR、肤色发灰发橙、明显滤镜、身份变化和背景替换。
输出应像专业摄影师完成的轻度自然修图，而不是重新生成一张不同的人像。执行统一调用星启智域后台图片编辑模型。`,
} as const;
