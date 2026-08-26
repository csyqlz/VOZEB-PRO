import { describe, expect, it } from "vitest";

import { adminSectionGroups } from "./admin-section-nav";

describe("admin navigation order", () => {
    it("keeps the existing business classifications and generation operations entry", () => {
        expect(adminSectionGroups.map((group) => group.title)).toEqual(["经营分析", "商品运营", "营销推广", "财务管理", "上游配置", "系统管理", "存储与备份", "内容运营", "帮助与支持"]);
        expect(adminSectionGroups.find((group) => group.title === "经营分析")?.items.map((item) => item.label)).toContain("生成运维");
        expect(adminSectionGroups.find((group) => group.title === "商品运营")?.items.map((item) => item.label)).toEqual(["套餐管理", "订单管理"]);
        expect(adminSectionGroups.find((group) => group.title === "营销推广")?.items.map((item) => item.label)).toEqual(["促销活动", "优惠券", "邀请奖励"]);
        expect(adminSectionGroups.find((group) => group.title === "财务管理")?.items.map((item) => item.label)).toEqual(["人民币计费", "支付渠道", "CDK 兑换", "财务流水"]);
        expect(adminSectionGroups.find((group) => group.title === "上游配置")?.items.map((item) => item.label)).toEqual(["模型渠道", "Agent Skills"]);
        expect(adminSectionGroups.find((group) => group.title === "系统管理")?.items.map((item) => item.label)).toEqual(["站点资料", "基础设置", "注销申请"]);
        expect(adminSectionGroups.find((group) => group.title === "存储与备份")?.items.map((item) => item.label)).toEqual(["本地媒体", "外部存储", "数据备份"]);
        expect(adminSectionGroups.find((group) => group.title === "内容运营")?.items.map((item) => item.label)).toEqual(["作品管理", "公告通知", "提示词运营"]);
        expect(adminSectionGroups.find((group) => group.title === "帮助与支持")?.items.map((item) => item.label)).toEqual(["版本维护", "使用文档"]);
    });
});
