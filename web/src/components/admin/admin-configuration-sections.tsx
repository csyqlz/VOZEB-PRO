"use client";

import { DataLifecyclePanel } from "@/components/admin/admin-data-lifecycle-settings";
import { GenerationConcurrencyPanel, GenerationCostControlPanel, GenerationDefaultsPanel } from "@/components/admin/admin-generation-settings";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { buildAdminSettingsPatch, resolveAdminSettingsAccess } from "@/components/admin/admin-settings-access";
import { LabeledControl, SectionTitle, SettingInlineToggle, SettingToggle } from "@/components/admin/admin-settings-controls";
import { SiteLogoPreview, SiteSettingStatus, siteSocialItems } from "@/components/admin/admin-site-preview";
import { Button, Input, InputNumber, Switch, Tag } from "antd";
import { Database, Globe2, Image as ImageIcon, Mail, Plus, Save, Search, Send, SlidersHorizontal, Sparkles, Trash2, Upload, UserCog } from "lucide-react";

import { SettingsAnchorItem, SettingsStatusTile } from "./admin-dashboard-elements";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminSiteSection({ controller }: { controller: AdminDashboardController }) {
    const { logoInputRef, iconInputRef, settings, settingsLoading, activeSection, saveSettings, updateSiteSetting, getLatestSiteSettings, updateSiteSocialSetting, addFriendLink, updateFriendLink, deleteFriendLink } = controller;
    if (activeSection !== "site") return null;
    return (
        <Panel variant="page">
            <PanelHeader
                title="网站设置"
                description="统一管理前台品牌、Logo、浏览器标题和搜索引擎展示信息。"
                actions={
                    <Button type="primary" loading={settingsLoading} icon={<Save className="size-4" />} onClick={() => saveSettings({ site: getLatestSiteSettings() }, "网站信息已保存")}>
                        保存网站设置
                    </Button>
                }
            />
            <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_360px] sm:p-5">
                <div className="space-y-5">
                    <div className="space-y-5 rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                        <SectionTitle icon={<Globe2 className="size-4" />} title="基础信息" />
                        <div className="grid gap-4 md:grid-cols-2">
                            <LabeledControl label="网站标题">
                                <Input value={settings.site.title} maxLength={40} placeholder="例如：无限创作" onChange={(event) => updateSiteSetting("title", event.target.value)} />
                            </LabeledControl>
                            <LabeledControl label="Logo URL">
                                <div className="flex gap-2">
                                    <Input value={settings.site.logoUrl} maxLength={2000} placeholder="/logo.svg 或 https://..." onChange={(event) => updateSiteSetting("logoUrl", event.target.value)} />
                                    <Button icon={<Upload className="size-4" />} onClick={() => logoInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                            </LabeledControl>
                            <LabeledControl label="浏览器图标 URL">
                                <div className="flex gap-2">
                                    <Input value={settings.site.iconUrl} maxLength={2000} placeholder="/icon.svg、/favicon.ico 或 https://..." onChange={(event) => updateSiteSetting("iconUrl", event.target.value)} />
                                    <Button icon={<Upload className="size-4" />} onClick={() => iconInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                            </LabeledControl>
                        </div>
                        <div className="rounded-md border border-dashed border-stone-300 bg-white p-3 text-xs leading-5 text-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-400">
                            Logo 用于站点品牌展示，浏览器图标用于 favicon、Apple 图标和 PWA；两者支持站内路径、远程 URL、data:image 或本地上传，最大 300KB。
                        </div>

                        <div className="border-t border-stone-200 pt-5 dark:border-stone-800">
                            <SectionTitle icon={<Search className="size-4" />} title="SEO 信息" />
                            <div className="mt-4 space-y-4">
                                <LabeledControl label="SEO 标题">
                                    <Input value={settings.site.seoTitle} maxLength={72} placeholder={settings.site.title} onChange={(event) => updateSiteSetting("seoTitle", event.target.value)} />
                                </LabeledControl>
                                <LabeledControl label="SEO 描述">
                                    <Input.TextArea value={settings.site.seoDescription} maxLength={180} rows={4} placeholder="用于搜索结果和社交分享摘要" onChange={(event) => updateSiteSetting("seoDescription", event.target.value)} />
                                </LabeledControl>
                                <LabeledControl label="SEO 关键词">
                                    <Input
                                        value={settings.site.seoKeywords}
                                        maxLength={240}
                                        placeholder={`${settings.site.title || "网站名称"},AI Agent,AI 绘图,AI 视频,画布,短剧`}
                                        onChange={(event) => updateSiteSetting("seoKeywords", event.target.value)}
                                    />
                                </LabeledControl>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <SectionTitle icon={<Globe2 className="size-4" />} title="首页收尾与社交媒体" />
                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">独立控制首页尾页展示</span>
                        </div>
                        <div className="mt-5 space-y-4">
                            <LabeledControl label="版权所有">
                                <Input
                                    value={settings.site.footerCopyright}
                                    maxLength={120}
                                    placeholder={`© 2026 ${settings.site.title || "网站名称"}. All rights reserved.`}
                                    onChange={(event) => updateSiteSetting("footerCopyright", event.target.value)}
                                />
                            </LabeledControl>
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_96px] gap-3">
                                    <LabeledControl label="使用条款链接">
                                        <Input value={settings.site.termsUrl} maxLength={2000} placeholder="/terms 或 https://..." onChange={(event) => updateSiteSetting("termsUrl", event.target.value)} />
                                    </LabeledControl>
                                    <LabeledControl label="版本">
                                        <Input value={settings.site.termsVersion} maxLength={80} placeholder="1.0" onChange={(event) => updateSiteSetting("termsVersion", event.target.value)} />
                                    </LabeledControl>
                                </div>
                                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_96px] gap-3">
                                    <LabeledControl label="隐私政策链接">
                                        <Input value={settings.site.privacyUrl} maxLength={2000} placeholder="/privacy 或 https://..." onChange={(event) => updateSiteSetting("privacyUrl", event.target.value)} />
                                    </LabeledControl>
                                    <LabeledControl label="版本">
                                        <Input value={settings.site.privacyVersion} maxLength={80} placeholder="1.0" onChange={(event) => updateSiteSetting("privacyVersion", event.target.value)} />
                                    </LabeledControl>
                                </div>
                            </div>
                            <div className="grid gap-3">
                                {siteSocialItems.map((item) => {
                                    const social = settings.site.socials[item.key];
                                    return (
                                        <div key={item.key} className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950/60">
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div className="flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                                                    <span className="flex size-7 items-center justify-center rounded-md bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200/70 dark:bg-cyan-950/40 dark:text-cyan-200 dark:ring-cyan-900/60">{item.icon}</span>
                                                    {item.label}
                                                </div>
                                                <Switch checked={social.enabled} checkedChildren="显示" unCheckedChildren="隐藏" onChange={(enabled) => updateSiteSocialSetting(item.key, { enabled })} />
                                            </div>
                                            <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
                                                <Input value={social.label} maxLength={32} placeholder={item.label} onChange={(event) => updateSiteSocialSetting(item.key, { label: event.target.value })} />
                                                <Input value={social.url} maxLength={2000} placeholder={item.placeholder} onChange={(event) => updateSiteSocialSetting(item.key, { url: event.target.value })} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="border-t border-stone-200 pt-4 dark:border-stone-800">
                                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">友情链接</div>
                                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">启用后会显示在首页底部友情链接区。</div>
                                    </div>
                                    <Button icon={<Plus className="size-4" />} onClick={addFriendLink}>
                                        添加链接
                                    </Button>
                                </div>
                                <div className="grid gap-3">
                                    {(settings.site.friendLinks || []).map((link) => (
                                        <div key={link.id} className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950/60">
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">{link.label || "友情链接"}</div>
                                                <div className="flex items-center gap-2">
                                                    <Switch checked={link.enabled} checkedChildren="显示" unCheckedChildren="隐藏" onChange={(enabled) => updateFriendLink(link.id, { enabled })} />
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} aria-label="删除友情链接" title="删除友情链接" onClick={() => deleteFriendLink(link.id)} />
                                                </div>
                                            </div>
                                            <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
                                                <Input value={link.label} maxLength={32} placeholder="Linux.do" onChange={(event) => updateFriendLink(link.id, { label: event.target.value })} />
                                                <Input value={link.url} maxLength={2000} placeholder="https://linux.do/" onChange={(event) => updateFriendLink(link.id, { url: event.target.value })} />
                                            </div>
                                        </div>
                                    ))}
                                    {!settings.site.friendLinks?.length ? <div className="rounded-md border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 dark:border-stone-800">暂无友情链接。</div> : null}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
                    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm shadow-stone-200/40 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20">
                        <SectionTitle icon={<ImageIcon className="size-4" />} title="前台预览" />
                        <div className="mt-5 rounded-lg border border-stone-200 bg-white p-5 text-stone-950 shadow-sm shadow-stone-200/60 dark:border-white/10 dark:bg-stone-950 dark:text-white dark:shadow-black/20">
                            <div className="flex items-center gap-3">
                                <SiteLogoPreview logoUrl={settings.site.logoUrl} />
                                <div className="min-w-0">
                                    <div className="truncate text-lg font-semibold">{settings.site.title || "网站名称"}</div>
                                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">首页导航品牌</div>
                                </div>
                            </div>
                            <div className="mt-6 border-t border-stone-200 pt-4 dark:border-white/10">
                                <div className="text-base font-semibold">{settings.site.seoTitle || settings.site.title}</div>
                                <p className="mt-2 line-clamp-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{settings.site.seoDescription}</p>
                            </div>
                        </div>
                    </div>
                    <SiteSettingStatus site={settings.site} />
                </div>
            </div>
        </Panel>
    );
}

export function AdminSettingsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        settings,
        setSettings,
        settingsLoading,
        mailTestLoading,
        mailTestTo,
        setMailTestTo,
        currentUser,
        activeSection,
        saveSettings,
        updateGenerationConcurrency,
        updateGenerationDefaults,
        updateGenerationCostControl,
        updateDataLifecycle,
        getLatestSettings,
        updateMailSetting,
        testMailSettings,
    } = controller;
    const access = resolveAdminSettingsAccess(currentUser);
    if (activeSection !== "settings" || (!access.system && !access.upstream)) return null;
    const description = access.system && access.upstream ? "管理账号注册、邮箱服务、生成与数据维护。" : access.system ? "管理账号注册、邮箱服务与数据维护。" : "管理生成并发、成本保护与默认参数。";
    const navigationClass =
        access.system && access.upstream ? "grid grid-cols-1 gap-1.5 sm:grid-cols-3 sm:gap-2 2xl:grid-cols-1" : access.system ? "grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-2 2xl:grid-cols-1" : "grid grid-cols-1 gap-1.5 2xl:grid-cols-1";
    return (
        <Panel variant="page">
            <PanelHeader
                title="系统设置"
                description={description}
                actions={
                    <div className="flex items-center justify-end gap-1.5 sm:w-auto sm:flex-row sm:gap-2">
                        <div className="hidden flex-wrap gap-2 text-xs text-stone-500 sm:flex dark:text-stone-400">
                            {access.system ? <Tag className="m-0">{settings.registrationEnabled ? "注册开放" : "注册关闭"}</Tag> : <Tag className="m-0">生成控制</Tag>}
                        </div>
                        <Button
                            type="primary"
                            aria-label="保存系统设置"
                            title="保存系统设置"
                            loading={settingsLoading}
                            icon={<Save className="size-4" />}
                            onClick={() => saveSettings(buildAdminSettingsPatch(getLatestSettings(), access), "系统设置已保存")}
                        >
                            <span className="sm:hidden">保存</span>
                            <span className="hidden sm:inline">保存系统设置</span>
                        </Button>
                    </div>
                }
            />
            <div className="space-y-3 p-3 sm:space-y-5 sm:p-5">
                <div className={`grid gap-2 sm:gap-3 ${access.system && access.upstream ? "grid-cols-2" : "grid-cols-1"}`}>
                    {access.system ? (
                        <SettingsStatusTile
                            icon={<UserCog className="size-4" />}
                            label="账号入口"
                            value={settings.registrationEnabled ? "注册开放" : "注册关闭"}
                            detail={settings.emailRegistrationEnabled ? "邮箱注册已启用" : "邮箱注册未启用"}
                            tone="cyan"
                        />
                    ) : null}
                    {access.upstream ? (
                        <SettingsStatusTile
                            icon={<Sparkles className="size-4" />}
                            label="生成控制"
                            value={`${settings.generationConcurrency.agent || 1} 个 Agent`}
                            detail={`图片 ${settings.generationDefaults.imageCount || 1} 张 / ${settings.generationDefaults.videoSeconds === -1 ? "视频智能时长" : `视频 ${settings.generationDefaults.videoSeconds || 5}s`}`}
                            tone="blue"
                        />
                    ) : null}
                </div>

                <div className="grid gap-4 2xl:grid-cols-[248px_minmax(0,1fr)]">
                    <aside className="2xl:sticky 2xl:top-4 2xl:self-start">
                        <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                            <div className="px-2 pb-2 text-xs font-semibold text-stone-500 dark:text-stone-400">设置顺序</div>
                            <nav className={navigationClass} aria-label="系统设置分组">
                                {access.system ? <SettingsAnchorItem href="#admin-settings-account" icon={<UserCog className="size-4" />} title="账号与邮箱" detail="注册、SMTP、测试邮件" /> : null}
                                {access.upstream ? <SettingsAnchorItem href="#admin-settings-generation" icon={<SlidersHorizontal className="size-4" />} title="生成控制" detail="默认值、并发上限" /> : null}
                                {access.system ? <SettingsAnchorItem href="#admin-settings-lifecycle" icon={<Database className="size-4" />} title="数据维护" detail="到期记录、批次大小" /> : null}
                            </nav>
                        </div>
                    </aside>

                    <div className="min-w-0 space-y-4">
                        {access.system ? (
                            <section id="admin-settings-account" className="scroll-mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                                <div className="grid gap-5 xl:grid-cols-[minmax(240px,0.72fr)_minmax(0,1.28fr)]">
                                    <div className="min-w-0 space-y-4">
                                        <SectionTitle icon={<UserCog className="size-4" />} title="账号策略" />
                                        <div className="grid gap-3">
                                            <SettingToggle
                                                title="开放注册"
                                                description="关闭后，新账号不能自助注册。"
                                                checked={settings.registrationEnabled}
                                                checkedChildren="开放"
                                                unCheckedChildren="关闭"
                                                onChange={(registrationEnabled) => setSettings((current) => ({ ...current, registrationEnabled }))}
                                            />
                                            <SettingToggle
                                                title="邮箱注册"
                                                description="开启后，注册页必须填写邮箱；邮箱唯一，不允许重复注册。"
                                                checked={settings.emailRegistrationEnabled}
                                                checkedChildren="开启"
                                                unCheckedChildren="关闭"
                                                onChange={(emailRegistrationEnabled) => setSettings((current) => ({ ...current, emailRegistrationEnabled }))}
                                            />
                                        </div>
                                    </div>

                                    <div className="min-w-0 border-t border-stone-200 pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0 dark:border-stone-800">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <SectionTitle icon={<Mail className="size-4" />} title="邮箱服务" />
                                            <Button className="w-full sm:w-auto" loading={mailTestLoading} icon={<Send className="size-4" />} onClick={() => void testMailSettings()}>
                                                测试邮箱
                                            </Button>
                                        </div>
                                        <div className="mt-4 grid gap-3">
                                            <div className="grid gap-3 sm:grid-cols-2">
                                                <LabeledControl label="邮箱类型">
                                                    <Input value={settings.mail.provider} placeholder="QQ 邮箱" onChange={(event) => updateMailSetting("provider", event.target.value)} />
                                                </LabeledControl>
                                                <LabeledControl label="SMTP 服务器">
                                                    <Input value={settings.mail.host} placeholder="smtp.qq.com" onChange={(event) => updateMailSetting("host", event.target.value)} />
                                                </LabeledControl>
                                            </div>
                                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                                                <LabeledControl label="端口">
                                                    <InputNumber className="w-full" min={1} max={65535} precision={0} value={settings.mail.port} onChange={(value) => updateMailSetting("port", Number(value) || 465)} />
                                                </LabeledControl>
                                                <SettingInlineToggle title="SSL" checked={settings.mail.secure} checkedChildren="开启" unCheckedChildren="关闭" onChange={(secure) => updateMailSetting("secure", secure)} />
                                            </div>
                                            <div className="grid gap-3 lg:grid-cols-2">
                                                <LabeledControl label="邮箱账号">
                                                    <Input value={settings.mail.username} placeholder="csyqlz@gmail.com" onChange={(event) => updateMailSetting("username", event.target.value)} />
                                                </LabeledControl>
                                                <LabeledControl label="授权码 / 密码">
                                                    <Input.Password value={settings.mail.password} placeholder="QQ 邮箱请填写 SMTP 授权码" onChange={(event) => updateMailSetting("password", event.target.value)} />
                                                </LabeledControl>
                                            </div>
                                            <div className="grid gap-3 sm:grid-cols-2">
                                                <LabeledControl label="发件邮箱">
                                                    <Input value={settings.mail.fromEmail} placeholder="默认使用邮箱账号" onChange={(event) => updateMailSetting("fromEmail", event.target.value)} />
                                                </LabeledControl>
                                                <LabeledControl label="发件名称">
                                                    <Input value={settings.mail.fromName} placeholder={settings.site.title || "网站名称"} onChange={(event) => updateMailSetting("fromName", event.target.value)} />
                                                </LabeledControl>
                                            </div>
                                            <LabeledControl label="测试收件邮箱">
                                                <Input value={mailTestTo} placeholder="留空则发送到发件邮箱" onChange={(event) => setMailTestTo(event.target.value)} />
                                            </LabeledControl>
                                            <div className="rounded-lg border border-cyan-200/70 bg-cyan-50/80 px-3 py-2 text-xs leading-5 text-cyan-900 dark:border-cyan-900/50 dark:bg-cyan-950/30 dark:text-cyan-100">
                                                QQ、网易、企业邮箱都可填写对应 SMTP；QQ 默认 `smtp.qq.com:465 SSL`，密码通常使用邮箱授权码。
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>
                        ) : null}

                        {access.upstream ? (
                            <section id="admin-settings-generation" className="scroll-mt-6 space-y-4">
                                <div className="grid gap-4 xl:grid-cols-2">
                                    <GenerationConcurrencyPanel settings={settings} onChange={updateGenerationConcurrency} />
                                    <GenerationCostControlPanel settings={settings} onChange={updateGenerationCostControl} />
                                </div>
                                <GenerationDefaultsPanel settings={settings} onChange={updateGenerationDefaults} />
                            </section>
                        ) : null}
                        {access.system ? (
                            <section id="admin-settings-lifecycle" className="scroll-mt-6">
                                <DataLifecyclePanel settings={settings} onChange={updateDataLifecycle} />
                            </section>
                        ) : null}
                    </div>
                </div>
            </div>
        </Panel>
    );
}
