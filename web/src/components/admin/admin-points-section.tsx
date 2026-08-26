"use client";

import { Button } from "antd";
import { Save } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { QuotaRuleTable } from "@/components/admin/admin-quota-rules";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminPointsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        activeSection,
        settings,
        setSettings,
        settingsLoading,
        customPointModel,
        setCustomPointModel,
        saveSettings,
        updateFreeDailyPoints,
        updateModelPointCost,
        updateModelPricing,
        updateGenerationPointMultiplier,
        deleteGenerationPointMultiplier,
        addCustomPointModel,
        deleteModelPointCost,
    } = controller;
    if (activeSection !== "points") return null;

    return (
        <Panel>
            <PanelHeader
                title="人民币计费规则"
                description="统一配置免费用户每日人民币余额、模型成本价/销售价与图片、视频参数倍率。"
                actions={
                    <Button
                        type="primary"
                        loading={settingsLoading}
                        icon={<Save className="size-4" />}
                        aria-label="保存人民币计费规则"
                        title="保存人民币计费规则"
                        onClick={() =>
                            saveSettings(
                                {
                                    freeDailyPointsEnabled: settings.freeDailyPointsEnabled,
                                    freeDailyPoints: settings.freeDailyPoints,
                                    modelPointCosts: settings.modelPointCosts,
                                    logicalModels: settings.logicalModels,
                                    generationPointMultipliers: settings.generationPointMultipliers,
                                },
                                "人民币计费规则已保存",
                            )
                        }
                    >
                        <span className="sm:hidden">保存</span>
                        <span className="hidden sm:inline">保存人民币计费规则</span>
                    </Button>
                }
            />
            <div className="min-w-0 p-3 sm:p-5">
                <QuotaRuleTable
                    settings={settings}
                    customModel={customPointModel}
                    onCustomModelChange={setCustomPointModel}
                    onAddCustomModel={addCustomPointModel}
                    onFreeDailyPointsEnabledChange={(freeDailyPointsEnabled) => setSettings((current) => ({ ...current, freeDailyPointsEnabled }))}
                    onFreeDailyPointsChange={updateFreeDailyPoints}
                    onModelPointCostChange={updateModelPointCost}
                    onModelPricingChange={updateModelPricing}
                    onModelPointCostDelete={deleteModelPointCost}
                    onGenerationPointMultiplierChange={updateGenerationPointMultiplier}
                    onGenerationPointMultiplierDelete={deleteGenerationPointMultiplier}
                />
            </div>
        </Panel>
    );
}
