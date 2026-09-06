export const CHARACTER_DESIGN_SKILL = {
    id: "character-design",
    name: "角色设定",
    description: "建立可持续复用的角色外观、服装、表情和多视图设定。",
    enabled: true,
    workspaces: ["image", "canvas", "drama"],
    action: "generate",
    requiresReference: false,
    defaultConfig: { quality: "high", count: 4 },
    keywords: ["角色设定", "角色设计", "人物设定", "角色图", "人物立绘", "多视图", "角色表"],
    instructions: `以角色设定工作流执行。先提炼身份、年龄、体态、脸部特征、发型、服装材质、配色、道具和情绪关键词，再生成同一角色的正面、侧面、背面和表情/动作参考。所有视图必须保持身份、比例、服装结构、发型轮廓和关键道具一致；采用清晰的角色设定板构图，给后续短剧、分镜和连续图片复用。不要随意改变种族、年龄、服装或脸部特征，也不要把四个视图生成成不同的人。`,
} as const;

export const IMAGE_MOTION_SKILL = {
    id: "image-motion",
    name: "图片动效",
    description: "把静态画面转成主体稳定、动作自然的短视频。",
    sourceUrl: "https://github.com/ArcReel/ArcReel",
    sourceVersion: "1.0.0",
    license: "MIT",
    enabled: true,
    workspaces: ["video"],
    action: "edit",
    requiresReference: true,
    defaultConfig: { videoSeconds: 5, vquality: "720" },
    keywords: ["图片动效", "图生视频", "图片转视频", "动效", "动画", "镜头推进", "首帧"],
    instructions: `以图生视频工作流执行。必须使用用户提供的参考图作为主体和首帧，保持人物、商品、场景、构图、色彩和文字位置稳定，只规划明确的动作、镜头运动、景别、速度和时长。默认生成 5 秒短视频；避免新增人物、改变主体身份、重绘商品 Logo、过度运动、闪烁和不必要的场景切换。`,
} as const;

export const DRAMA_PLANNING_SKILL = {
    id: "drama-planning",
    name: "短剧策划",
    description: "从主题到角色、场景和分镜，整理可继续生产的短剧方案。",
    sourceUrl: "https://github.com/ArcReel/ArcReel",
    sourceVersion: "1.0.0",
    license: "MIT",
    enabled: true,
    workspaces: ["image", "video", "drama"],
    action: "generate",
    requiresReference: false,
    defaultConfig: { count: 1, videoSeconds: 5 },
    keywords: ["短剧策划", "短剧", "剧本", "分镜", "剧集", "镜头", "故事板"],
    instructions: `以短剧生产工作流执行。先整理主题、受众、冲突、角色、场景、道具和叙事节奏，再拆成可审核的剧集与镜头；每个镜头明确画面主体、对白/旁白、时长、景别、机位和动作，并为后续角色图、场景图和视频任务保留稳定引用。不要直接跳过结构分析，也不要在用户未明确要求时擅自创建 Canvas 或短剧项目。`,
} as const;

export const BRAND_CONTENT_SYSTEM_SKILL = {
    id: "brand-content-system",
    name: "品牌内容整合",
    description: "把品牌定位、视觉规范和传播目标整理成可连续生产的一组内容。",
    enabled: true,
    workspaces: ["image", "video", "canvas", "drama"],
    action: "generate",
    requiresReference: false,
    defaultConfig: { quality: "high", count: 1, videoSeconds: 5 },
    keywords: ["品牌", "品牌视觉", "品牌内容", "视觉规范", "营销活动", "内容整合", "系列内容", "品牌升级"],
    instructions: `以品牌内容整合工作流执行。先提炼品牌定位、目标人群、核心卖点、语气、主色、字体气质、图形语言和禁用表达，再形成可复用的视觉与文案方向。根据目标自动拆分为必要的文字、图片、视频或短剧交付物，并让所有交付物共享同一主题、色彩、主体和信息层级。优先输出一套可执行的内容组合，不为凑数量生成重复素材；每项交付物明确用途、画幅、镜头/构图、时长或文案长度。发现缺少品牌信息时先使用中性、可替换的占位方向，不擅自编造品牌事实。`,
} as const;

export const PRODUCT_CAMPAIGN_SKILL = {
    id: "product-campaign",
    name: "商品营销创作",
    description: "围绕商品卖点生成主图、场景图、短视频和促销内容组合。",
    enabled: true,
    workspaces: ["image", "video", "canvas"],
    action: "generate",
    requiresReference: false,
    defaultConfig: { quality: "high", count: 1, videoSeconds: 6 },
    keywords: ["商品营销", "商品广告", "产品宣传", "主图", "卖点", "促销", "新品", "详情页", "广告素材"],
    instructions: `以商品营销创作工作流执行。先识别商品结构、材质、核心卖点、价格/促销信息、目标人群和投放平台，再规划主图、卖点场景、细节特写、信息图或短视频中的最小有效组合。商品轮廓、颜色、包装、Logo 和文字必须与参考素材一致；每件素材只突出一个主要卖点，避免把多个卖点堆在一张图里。涉及价格、参数、功效或对比时只使用用户提供的事实，不凭空补充；输出前检查品牌安全区、文字可读性、平台画幅和行动引导。`,
} as const;

export const DEFAULT_CREATIVE_SHORTCUT_SKILLS = [CHARACTER_DESIGN_SKILL, IMAGE_MOTION_SKILL, DRAMA_PLANNING_SKILL, BRAND_CONTENT_SYSTEM_SKILL, PRODUCT_CAMPAIGN_SKILL] as const;
