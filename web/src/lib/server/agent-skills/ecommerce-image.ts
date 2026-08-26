export const ECOMMERCE_IMAGE_SKILL = {
    id: "ecommerce-image",
    name: "电商生图",
    description: "覆盖主图、详情页、社媒、UGC、模特、包装和营销活动的电商视觉生成。",
    sourceUrl: "https://github.com/buluslan/gpt-image2-ecommerce",
    sourceVersion: "0.1.0",
    license: "MIT",
    enabled: true,
    workspaces: ["image", "canvas"],
    action: "generate",
    requiresReference: false,
    defaultConfig: { quality: "high", count: 1 },
    keywords: ["电商", "商品", "主图", "详情页", "淘宝", "天猫", "京东", "拼多多", "抖音商城", "Amazon", "Shopify", "Etsy", "TikTok Shop", "小红书", "UGC", "包装", "模特"],
    instructions: `基于 buluslan/gpt-image2-ecommerce v0.1.0（MIT）适配到星启智域后台模型执行。
先识别场景、商品类别、材质、卖点、风格、目标平台、画幅和参考商品图。只选择最匹配的一个场景模板，保持提示词简洁。
场景匹配：白底图/主图→hero；场景图/生活图→lifestyle；平铺/俯拍→flat-lay；细节/微距→macro；海报/banner/促销→poster；小红书/Instagram/TikTok→social；UGC/买家秀/GRWM→ugc；模特→model；前后对比→before-after；包装/礼盒→packaging；A+/详情页/信息图→infographic；创意概念→creative；尺寸/规格/步骤→size-spec；套装/组合→bundle；直播→livestream；试穿→virtual-try-on；拆解/爆炸图→exploded-view；隐形模特→ghost-mannequin；多角度/网格→multi-angle；杂志/封面→editorial；季节活动→seasonal；奢华氛围→luxury；设备/SaaS/App→device-mockup；店铺门面→storefront；运动健身→sports。
提示词必须包含：商品主体与材质、背景、光线方向与质感、构图和镜头、目标平台与用途、比例、商业摄影质量。使用参考图时明确要求商品轮廓、颜色、材质、Logo、包装和文字位置一致，不得改变商品结构。
平台适配：淘宝/天猫/京东/拼多多优先清晰主体、白底主图、卖点场景和详情页模块；Amazon 主图遵循纯白背景、商品主体突出且不添加无关装饰，A+ 内容再使用场景与信息图；Shopify/Etsy 强调品牌氛围和生活方式；抖音商城/TikTok Shop/小红书优先竖版、真实使用感和社媒构图。
UGC/直播/社媒场景避免过度 AI 感：使用真实手机拍摄语汇、轻微噪点和不完美构图、自然皮肤与真实环境，避免 perfect、flawless、hyper-realistic 等词。
执行时调用星启智域后台已配置图片模型，不调用 Codex CLI、Shell、curl 或本地 HTTP 服务。`,
} as const;
