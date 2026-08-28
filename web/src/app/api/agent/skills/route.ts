import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import type { AgentSkillWorkspace } from "@/lib/auth/store-types";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("agent.run", user.id);
    if (blocked) return blocked;
    const workspace = new URL(request.url).searchParams.get("workspace") || "image";
    const settings = await getAuthSettings();
    const allWorkspaces = workspace === "all" || workspace === "chat";
    const skills = settings.agentSkills.filter((skill) => skill.enabled && (allWorkspaces || (skill.workspaces || ["image"]).includes(workspace as AgentSkillWorkspace))).map(({ instructions: _instructions, ...skill }) => skill);
    return NextResponse.json({ code: 0, data: { skills }, msg: "OK" });
}
