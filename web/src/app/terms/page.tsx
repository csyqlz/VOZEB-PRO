import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, BadgeCheck, Ban, Coins, Copyright, FileWarning, RefreshCcw, Scale, UserRoundCheck } from "lucide-react";

import { getPublicSiteSettings } from "@/lib/server/site-metadata";

const UPDATED_AT = "2026 年 8 月 13 日";

const highlights = [
    { title: "你对输入和发布负责", body: "请确保有权使用上传的文字、图片、音视频、人物肖像、品牌和其他素材，并在发布前检查 AI 生成结果。", icon: UserRoundCheck },
    { title: "余额与生成状态可核对", body: "人民币价格和预计扣费在提交前或任务详情中展示；符合系统退款条件的失败或取消任务会记录返还流水。", icon: Coins },
    { title: "禁止违法与侵权使用", body: "不得利用服务实施欺诈、冒充、骚扰、侵犯隐私、传播违法内容、攻击系统或绕过安全限制。", icon: Ban },
] as const;

function termsSections(siteTitle: string) {
    return [
        {
            title: "协议范围与接受",
            paragraphs: [
                `本服务条款适用于你对 ${siteTitle} 网站、智能创作助手、图片与视频生成、画布、短剧、素材、作品发布、套餐和人民币余额等功能的访问与使用。`,
                "注册、登录或继续使用服务，即表示你已阅读并同意本条款及隐私政策。若你代表机构使用服务，你确认有权代表该机构接受本条款。",
            ],
        },
        {
            title: "账号与安全",
            paragraphs: [
                "请提供真实、可用的注册信息，妥善保管密码和登录设备，并对账号下的操作负责。发现未授权访问时应立即修改密码并通过帮助中心联系站点运营方。",
                "不得转售账号、批量注册、冒用他人身份或绕过权限、并发、余额和风控限制。我们可以为保护用户与服务安全而限制异常请求、暂停高风险操作或要求进一步验证。",
            ],
        },
        {
            title: "创作内容与知识产权",
            paragraphs: [
                "你保留对自己合法上传内容所享有的权利。为执行你的请求，你授予服务在必要范围内存储、复制、转码、传输和处理这些内容的许可；该许可不代表我们取得内容所有权。",
                "你应确保拥有素材和提示词所需的版权、商标、肖像、声音、隐私和其他授权。不要要求生成或发布足以使他人误认、受骗或权益受损的内容。",
                "在相关模型服务条款和适用法律允许的范围内，你可以使用生成结果；但 AI 输出可能与他人内容相似，也不保证具备独占性、可版权性或适合特定商业用途。发布前应自行核验并承担使用责任。",
            ],
        },
        {
            title: "AI 服务说明",
            paragraphs: [
                "智能创作助手的回复和生成结果由自动化模型提供，可能出现事实错误、遗漏、偏差、画面瑕疵或不可用结果。服务不构成法律、医疗、投资或其他专业意见。",
                "模型、生成速度、可用参数和结果数量会因服务能力、网络和内容安全要求而变化。正在运行的任务可能需要较长时间，请依据页面状态处理，不要重复提交同一任务。",
            ],
        },
        {
            title: "套餐、余额、支付与退款",
            paragraphs: [
                "商品名称、人民币价格、余额权益和支付方式以购买页及订单快照为准。请在付款前核对订单；支付结果以支付渠道确认并经系统验证后的订单状态为准。",
                "生成任务按实际展示的模型、参数、数量和规则扣除人民币余额。任务在系统认定的失败或取消条件下，会按对应任务记录自动返还符合条件的余额；已成功交付、已实际消耗或因用户提交违法内容导致的费用不当然退还。",
                "如需订单退款，请通过站点运营方公布的客服渠道提交订单号和原因。退款是否可受理、退款范围、原支付渠道到账时间及已发放权益的回收，以商品说明、适用法律和最终处理结果为准。不要对同一订单重复付款或重复申请。",
            ],
        },
        {
            title: "禁止行为与内容治理",
            paragraphs: [
                "不得上传、生成或传播违法犯罪、侵权、仇恨骚扰、性剥削、未成年人不当内容、恶意虚假信息、隐私泄露、欺诈冒充、恶意软件或规避安全措施的内容。",
                "公开作品可能接受自动或人工审核、举报、下架和申诉处理。为保护用户和平台，我们可以拒绝任务、移除公开内容、限制功能或暂停账号；涉及严重违法风险时可依法保存证据并配合主管机关。",
            ],
        },
        {
            title: "服务可用性与责任边界",
            paragraphs: [
                "我们会尽力维持服务稳定，但不保证服务永不中断、所有模型持续可用或每次生成都满足主观预期。维护、服务故障、网络、不可抗力和法律要求可能导致延迟、中断或功能调整。",
                "在适用法律允许的范围内，我们不对间接损失、预期收益损失或因用户未备份重要成果、未核验 AI 输出、无权使用素材而产生的损失承担责任；依法不能排除或限制的责任不受本条影响。",
            ],
        },
        {
            title: "删除、注销、条款更新与争议",
            paragraphs: [
                "你可以删除自己的创作记录或提交账户注销申请。删除和注销会按媒体引用保护、交易记录和法律保留要求执行，具体数据处理见隐私政策。",
                "我们可能因功能、服务能力、价格或法律变化更新条款。重要变化会通过站内公告、登录或重新同意流程提示；继续使用前请阅读更新版本。",
                "如对订单、内容处置、隐私或本条款有异议，请先通过帮助中心和站点运营方公布的客服渠道协商。法律适用、管辖和消费者不可放弃的权利，以实际运营主体所在地、你的所在地及适用法律为准。",
            ],
        },
    ] as const;
}

export async function generateMetadata(): Promise<Metadata> {
    const site = await getPublicSiteSettings();
    return {
        title: "服务条款",
        description: `了解使用 ${site.title} 账号、AI 创作、用户内容、人民币余额支付、退款、公开发布与账号注销的规则。`,
        alternates: { canonical: "/terms" },
    };
}

export default async function TermsPage() {
    const site = await getPublicSiteSettings();
    const sections = termsSections(site.title);
    return (
        <main className="app-scroll-page bg-[#f7f8fa] text-stone-800 dark:bg-[#0f1114] dark:text-stone-200">
            <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-8">
                <Link
                    href="/"
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-200 bg-white px-3.5 text-sm font-medium text-stone-700 transition hover:border-cyan-300 hover:text-cyan-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:border-cyan-500/50 dark:hover:text-cyan-200"
                >
                    <ArrowLeft className="size-4" />
                    返回首页
                </Link>

                <article className="mt-5 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,.08)] dark:border-white/10 dark:bg-[#15181c] dark:shadow-black/30">
                    <header className="bg-[#101211] px-5 py-8 text-white sm:px-9 sm:py-10">
                        <div className="inline-flex items-center gap-2 text-sm font-medium text-cyan-200">
                            <Scale className="size-4" />
                            使用规则与用户权益
                        </div>
                        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">服务条款</h1>
                        <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300 sm:text-base">这些条款面向实际使用 {site.title} 的用户，说明账号、创作内容、AI 结果、人民币余额支付、退款和公开发布的权利与责任。</p>
                        <p className="mt-5 text-xs text-stone-400">生效及最近更新：{UPDATED_AT}</p>
                    </header>

                    <div className="grid gap-3 border-b border-stone-200 p-4 sm:grid-cols-3 sm:p-6 dark:border-white/10">
                        {highlights.map(({ title, body, icon: Icon }) => (
                            <section key={title} className="rounded-lg border border-stone-200 bg-stone-50 p-4 dark:border-white/10 dark:bg-white/[0.035]">
                                <Icon className="size-5 text-cyan-600 dark:text-cyan-300" />
                                <h2 className="mt-3 text-sm font-semibold text-stone-950 dark:text-white">{title}</h2>
                                <p className="mt-1.5 text-xs leading-5 text-stone-600 dark:text-stone-400">{body}</p>
                            </section>
                        ))}
                    </div>

                    <div className="divide-y divide-stone-200 px-5 sm:px-9 dark:divide-white/10">
                        {sections.map((section, index) => (
                            <section key={section.title} className="grid gap-3 py-6 sm:grid-cols-[44px_minmax(0,1fr)] sm:py-8">
                                <span className="grid size-8 place-items-center rounded-full bg-cyan-50 text-xs font-semibold text-cyan-700 dark:bg-cyan-300/10 dark:text-cyan-300">{String(index + 1).padStart(2, "0")}</span>
                                <div>
                                    <h2 className="text-lg font-semibold text-stone-950 dark:text-white">{section.title}</h2>
                                    <div className="mt-3 space-y-3 text-sm leading-7 text-stone-600 dark:text-stone-400">
                                        {section.paragraphs.map((paragraph) => (
                                            <p key={paragraph}>{paragraph}</p>
                                        ))}
                                    </div>
                                </div>
                            </section>
                        ))}
                    </div>

                    <footer className="grid gap-3 border-t border-stone-200 bg-stone-50 px-5 py-5 text-xs leading-5 text-stone-600 sm:grid-cols-3 sm:px-9 dark:border-white/10 dark:bg-white/[0.025] dark:text-stone-400">
                        <span className="flex items-start gap-2">
                            <Copyright className="mt-0.5 size-4 shrink-0" />
                            上传和发布前确认素材与人物授权。
                        </span>
                        <span className="flex items-start gap-2">
                            <RefreshCcw className="mt-0.5 size-4 shrink-0" />
                            失败任务按真实状态处理重试与余额返还。
                        </span>
                        <span className="flex items-start gap-2">
                            <FileWarning className="mt-0.5 size-4 shrink-0" />
                            重要用途前核验 AI 输出与适用规则。
                        </span>
                    </footer>
                </article>
            </div>
        </main>
    );
}
