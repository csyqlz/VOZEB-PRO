const base = {
    enabled: true,
    action: "generate" as const,
    requiresReference: false,
};

export const BRAND_VISUAL_SYSTEM_SKILL = {
    ...base,
    id: "brand-visual-system",
    name: "品牌视觉统一",
    description: "把 Logo、色彩、字体和视觉语气统一到整套图片与画布物料中。",
    workspaces: ["image", "canvas"] as const,
    keywords: ["品牌", "VI", "视觉规范", "Logo", "品牌色", "系列海报", "统一风格"],
    defaultConfig: { quality: "high", count: 1 },
    instructions: `先提炼品牌名称、Logo 使用边界、品牌色、字体气质、目标人群和应用场景，再给出一套可复用的视觉方向。所有系列物料必须保持 Logo 比例与位置规则、品牌色、留白、字体层级、摄影/插画风格一致。用户没有提供品牌资产时不得虚构具体 Logo；使用参考图时优先保留真实品牌资产，不擅自改字、改色或替换标识。输出应包含主体、构图、色彩、光线、文字区域、画幅和禁止事项，便于后续连续生成。`,
} as const;

export const SOCIAL_CONTENT_SKILL = {
    ...base,
    id: "social-content",
    name: "社媒内容适配",
    description: "按平台和传播目标生成封面、帖子、短视频画面与配套文案。",
    workspaces: ["image", "video", "canvas"] as const,
    keywords: ["社媒", "小红书", "抖音", "视频号", "微博", "Instagram", "封面", "种草", "广告"],
    defaultConfig: { quality: "high", count: 1, videoSeconds: 5 },
    instructions: `先判断平台、内容目标、受众、行动号召和画幅，再规划信息层级。封面在首屏突出一个核心信息，正文物料保留清晰标题、主体和品牌识别；竖版优先 9:16，横版按平台用途适配。短视频同时规划前 2 秒吸引点、主体动作、镜头节奏、字幕安全区和结尾 CTA。避免堆砌文字、虚假夸张承诺、平台水印和无法阅读的小字；同一活动的图片与视频保持人物、商品、色彩和文案一致。`,
} as const;

export const STORYBOARD_SHOT_SKILL = {
    ...base,
    id: "storyboard-shot",
    name: "分镜镜头设计",
    description: "把创意拆成可执行的镜头、画面、动作、对白和转场。",
    workspaces: ["image", "video", "canvas", "drama"] as const,
    keywords: ["分镜", "镜头", "故事板", "运镜", "转场", "脚本", "拍摄计划"],
    defaultConfig: { count: 4, videoSeconds: 5 },
    instructions: `先明确叙事目的、镜头数量、总时长和画幅，再按镜头顺序输出景别、机位、主体、动作、对白/旁白、时长、转场和声音提示。每个镜头必须能独立执行，并通过角色外观、场景方位、道具和光线保持连续性。视频任务优先给出一个可落地的镜头方案，不擅自增加角色、地点或剧情；复杂项目应先交付分镜结构，再按依赖生成角色图、场景图和视频。`,
} as const;

export const PRODUCT_PHOTO_EDIT_SKILL = {
    ...base,
    id: "product-photo-edit",
    name: "商品图片精修",
    description: "在保持商品真实结构的前提下完成抠图、清洁、换背景和细节优化。",
    action: "edit" as const,
    requiresReference: true,
    workspaces: ["image", "canvas"] as const,
    keywords: ["商品修图", "抠图", "换背景", "白底图", "清洁瑕疵", "产品摄影", "详情页"],
    defaultConfig: { quality: "high", count: 1 },
    instructions: `必须使用用户提供的商品图作为参考。保持商品轮廓、尺寸比例、材质、颜色、结构、接口、Logo、包装文字和配件数量完全一致，只按要求进行抠图、背景替换、灰尘反光清理、曝光白平衡和阴影优化。商品主图优先干净背景与真实接触阴影，详情页可补充卖点场景但不得改变产品功能或凭空添加配件。禁止重绘 Logo、篡改文字、拉伸变形、过度锐化和生成不存在的细节。`,
} as const;

export const STYLE_CONSISTENCY_SKILL = {
    ...base,
    id: "style-consistency",
    name: "系列风格一致",
    description: "让多张图片、多段视频和多个画布节点共享同一套主体与视觉语言。",
    workspaces: ["image", "video", "canvas", "drama"] as const,
    keywords: ["系列", "连续性", "风格统一", "角色一致", "场景一致", "多张图", "多镜头"],
    defaultConfig: { quality: "high", count: 4, videoSeconds: 5 },
    instructions: `先建立系列基准：主体身份、角色外观、场景布局、色板、光线、镜头语言、材质和负面约束。每个产物都必须复用同一基准，只改变用户明确要求变化的内容。涉及多镜头时记录时间顺序、空间方位、服装道具和动作衔接；涉及多张图片时保持构图骨架和主体比例。若缺少参考素材，先输出可执行的基准设定，再生成第一张作为后续参考，不要用随机变化冒充系列。`,
} as const;

export const CREATIVE_SUITE_SKILLS = [BRAND_VISUAL_SYSTEM_SKILL, SOCIAL_CONTENT_SKILL, STORYBOARD_SHOT_SKILL, PRODUCT_PHOTO_EDIT_SKILL, STYLE_CONSISTENCY_SKILL] as const;
