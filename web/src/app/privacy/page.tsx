import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Database, Eye, FileDown, MailCheck, ShieldCheck, Sparkles, Trash2 } from "lucide-react";

import { getPublicSiteSettings } from "@/lib/server/site-metadata";

const UPDATED_AT = "2026 年 8 月 13 日";

const highlights = [
    { title: "创作内容由你掌控", body: "你的对话、项目、提示词和媒体用于提供你主动请求的功能，不会被公开展示，除非你明确发布作品或分享内容。", icon: Eye },
    { title: "AI 请求会经过第三方", body: "当你使用已配置的文本、图片、视频或其他媒体模型时，必要的提示词、参数和你选择的参考素材会发送给实际执行任务的模型服务商。", icon: Sparkles },
    { title: "支持查阅、导出与注销", body: "你可以在个人中心管理资料、查看订单与余额记录、导出账户数据，并提交或撤回账户注销申请。", icon: FileDown },
] as const;

const sections = [
    {
        title: "我们处理哪些信息",
        paragraphs: [
            "账号信息：用户名、显示名称、邮箱、头像、加密后的密码凭据、登录与安全记录，以及你同意本政策和服务条款的版本与时间。",
            "创作与项目数据：你提交的文字、提示词、附件、创作会话、画布、短剧、素材、生成参数、任务状态和生成结果。",
            "交易与权益数据：订单、支付渠道返回的交易状态、套餐、人民币余额与流水、优惠券和退款记录。我们不在页面中保存或展示完整银行卡信息。",
            "设备与运行信息：为保障登录、安全、限流和故障排查而处理的 IP 地址、浏览器信息、请求时间、错误和必要审计记录。",
        ],
    },
    {
        title: "我们为什么处理这些信息",
        paragraphs: [
            "用于创建和保护账号、恢复你的会话与项目、执行生成任务、展示与下载结果、完成支付和人民币余额结算，以及响应你主动发起的客服、安全和注销请求。",
            "用于防止滥用、欺诈、越权访问和重复扣费，定位服务故障，并履行适用法律要求。我们只在实现相应功能所需的范围内处理信息。",
        ],
    },
    {
        title: "AI 与自动化处理",
        paragraphs: [
            "智能创作助手会先理解你的本轮需求，再选择当前可用的模型和参数。内部规划提示词、模型选择过程和执行规则不会作为你的公开内容展示。",
            "模型服务可能处理你的提示词、参考素材和任务参数，并生成文字或媒体结果。不同模型服务商的数据保留与训练政策可能不同；请避免提交身份证件、财务信息、医疗信息、未公开商业秘密等不必要的敏感内容。",
            "AI 结果可能不准确、不完整或与现实不符。发布、商用或用于重要决策前，请自行核验事实、版权、肖像和合规风险。",
        ],
    },
    {
        title: "我们何时向第三方提供信息",
        paragraphs: [
            "我们只会在提供具体功能所需时，将必要信息交给模型服务、支付服务、邮件发送服务、对象存储或内容分发服务。第三方只会收到完成相应任务所需的数据。",
            "当法律法规、司法或监管机关依法要求，或为了保护用户、平台和他人的合法权益时，我们可能依法披露必要信息。我们不会出售你的个人信息。",
        ],
    },
    {
        title: "保存期限与安全",
        paragraphs: [
            "账号、项目、会话和长期素材通常保存到你删除相应内容或注销账号；发送前的临时附件只保存在当前页面内存，发送后才会作为账户资产保存。订单、支付、退款、安全审计等记录会按适用法律及争议处理需要保留必要期限。",
            "我们采取访问控制、加密凭据、媒体归属校验、短期签名地址、操作审计和备份等措施保护数据。但任何网络服务都无法承诺绝对安全，请妥善保护密码并及时报告异常。",
        ],
    },
    {
        title: "你的选择与权利",
        paragraphs: [
            "你可以在个人中心修改个人资料和密码，查看订单、余额与消费记录，下载自己有权限访问的媒体，并导出账户数据。",
            "你可以删除创作会话、画布、短剧、素材或发布记录。系统会先检查其他项目是否仍在引用同一媒体；仍被合法引用的文件会保留到引用解除，避免其他项目静默失效。",
            "你可以在个人中心提交账户注销申请，并在受理前撤回。注销处理会删除或去标识化可删除的账户与创作数据；依法必须保留的交易、安全和争议记录会在法定期限内隔离保存。",
        ],
    },
    {
        title: "未成年人、政策更新与联系",
        paragraphs: [
            "如果你未达到所在地独立同意网络服务的法定年龄，应在监护人阅读并同意后使用本服务。请勿上传未成年人的敏感信息或不当内容。",
            "我们可能因功能、供应商或法律变化更新本政策。重要变化会通过站内公告、登录或重新同意流程提示，并保留你注册时同意的政策版本记录。",
            "如需提出隐私查阅、更正、删除、注销或投诉请求，请先使用个人中心和帮助中心提供的入口；需要人工处理时，请通过站点运营方公布的客服渠道联系。",
        ],
    },
] as const;

export async function generateMetadata(): Promise<Metadata> {
    const site = await getPublicSiteSettings();
    return {
        title: "隐私政策",
        description: `了解 ${site.title} 如何处理账号、创作内容、AI 请求、交易和媒体数据，以及你可以行使的选择与权利。`,
        alternates: { canonical: "/privacy" },
    };
}

export default async function PrivacyPage() {
    const site = await getPublicSiteSettings();
    return (
        <main className="app-scroll-page bg-[#f7f8fa] text-stone-800 dark:bg-[#0f1114] dark:text-stone-200">
            <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-8">
                <Link
                    href="/"
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-200 bg-white px-3.5 text-sm font-medium text-stone-700 transition hover:border-emerald-300 hover:text-emerald-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:border-emerald-500/50 dark:hover:text-emerald-200"
                >
                    <ArrowLeft className="size-4" />
                    返回首页
                </Link>

                <article className="mt-5 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,.08)] dark:border-white/10 dark:bg-[#15181c] dark:shadow-black/30">
                    <header className="bg-[#101211] px-5 py-8 text-white sm:px-9 sm:py-10">
                        <div className="inline-flex items-center gap-2 text-sm font-medium text-emerald-200">
                            <ShieldCheck className="size-4" />
                            隐私与数据保护
                        </div>
                        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">隐私政策</h1>
                        <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-300 sm:text-base">本政策面向 {site.title} 用户，说明我们在你注册、创作、购买和管理账户时如何处理信息，以及你可以如何控制自己的数据。</p>
                        <p className="mt-5 text-xs text-stone-400">生效及最近更新：{UPDATED_AT}</p>
                    </header>

                    <div className="grid gap-3 border-b border-stone-200 p-4 sm:grid-cols-3 sm:p-6 dark:border-white/10">
                        {highlights.map(({ title, body, icon: Icon }) => (
                            <section key={title} className="rounded-lg border border-stone-200 bg-stone-50 p-4 dark:border-white/10 dark:bg-white/[0.035]">
                                <Icon className="size-5 text-emerald-600 dark:text-emerald-300" />
                                <h2 className="mt-3 text-sm font-semibold text-stone-950 dark:text-white">{title}</h2>
                                <p className="mt-1.5 text-xs leading-5 text-stone-600 dark:text-stone-400">{body}</p>
                            </section>
                        ))}
                    </div>

                    <div className="divide-y divide-stone-200 px-5 sm:px-9 dark:divide-white/10">
                        {sections.map((section, index) => (
                            <section key={section.title} className="grid gap-3 py-6 sm:grid-cols-[44px_minmax(0,1fr)] sm:py-8">
                                <span className="grid size-8 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700 dark:bg-emerald-300/10 dark:text-emerald-300">{String(index + 1).padStart(2, "0")}</span>
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
                            <Database className="mt-0.5 size-4 shrink-0" />
                            业务数据按账号和具体功能范围读取。
                        </span>
                        <span className="flex items-start gap-2">
                            <MailCheck className="mt-0.5 size-4 shrink-0" />
                            验证码只用于验证当前操作并在有效期后失效。
                        </span>
                        <span className="flex items-start gap-2">
                            <Trash2 className="mt-0.5 size-4 shrink-0" />
                            删除与注销按引用和法定保留边界执行。
                        </span>
                    </footer>
                </article>
            </div>
        </main>
    );
}
