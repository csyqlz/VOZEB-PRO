import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-one" })) }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: vi.fn(async () => null) }));

import { POST } from "./route";

describe("POST /api/video-tasks", () => {
    it("does not let the browser register an upstream task", async () => {
        const response = await POST(new Request("http://localhost/api/video-tasks", { method: "POST" }));

        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ error: "旧视频任务登记接口已停用，请通过服务端视频生成接口创建任务" });
    });
});
