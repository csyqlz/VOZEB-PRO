import type { VozebCmsWorkflowDefinition, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";

type ApiResponse<T> = { code: number; data: T; msg: string };

export function listVozebCmsWorkflows(projectId?: string, projectType?: string) {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}${projectType ? `&projectType=${encodeURIComponent(projectType)}` : ""}` : "";
    return request<{ workflows: VozebCmsWorkflowDefinition[] }>(`/api/vozeb-cms/workflows${query}`).then((data) => data.workflows);
}

export function getVozebCmsWorkflowDashboard(projectId?: string, projectType?: string) {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}${projectType ? `&projectType=${encodeURIComponent(projectType)}` : ""}` : "";
    return request<{ workflows: VozebCmsWorkflowDefinition[]; runs: VozebCmsWorkflowRun[] }>(`/api/vozeb-cms/workflows${query}`);
}

export function createVozebCmsWorkflow(input: Partial<VozebCmsWorkflowDefinition>) {
    return request<{ workflow: VozebCmsWorkflowDefinition }>("/api/vozeb-cms/workflows", { method: "POST", body: JSON.stringify(input) }).then((data) => data.workflow);
}

export function startVozebCmsWorkflow(workflowId: string, input: { context?: Record<string, unknown>; idempotencyKey?: string; autoStart?: boolean } = {}) {
    return request<{ run: VozebCmsWorkflowRun }>(`/api/vozeb-cms/workflows/${encodeURIComponent(workflowId)}/runs`, { method: "POST", body: JSON.stringify(input) }).then((data) => data.run);
}

export function createVozebCmsDramaWorkflow(projectId: string, id?: string) {
    return request<{ workflow: VozebCmsWorkflowDefinition }>("/api/vozeb-cms/workflows/templates/drama", { method: "POST", body: JSON.stringify({ projectId, id }) }).then((data) => data.workflow);
}

export async function startVozebCmsDramaEpisodeWorkflow(projectId: string, episodeId: string, idempotencyKey: string) {
    let workflows = await listVozebCmsWorkflows(projectId, "drama");
    let workflow = workflows.find((item) => item.id === `workflow-drama-${projectId}`) || workflows[0];
    if (!workflow) {
        try {
            workflow = await createVozebCmsDramaWorkflow(projectId);
        } catch {
            workflows = await listVozebCmsWorkflows(projectId, "drama");
            workflow = workflows.find((item) => item.id === `workflow-drama-${projectId}`) || workflows[0];
        }
    }
    if (!workflow) throw new Error("短剧自动化流程准备失败");
    return startVozebCmsWorkflow(workflow.id, { context: { surface: "drama", episodeId }, idempotencyKey });
}

export function subscribeVozebCmsWorkflowRun(runId: string, onRun: (run: VozebCmsWorkflowRun) => void) {
    const source = new EventSource(`/api/vozeb-cms/workflows/runs/${encodeURIComponent(runId)}/events`);
    const handle = (event: MessageEvent<string>) => {
        try {
            const payload = JSON.parse(event.data) as VozebCmsWorkflowRun | { data?: VozebCmsWorkflowRun };
            const run = "status" in payload ? payload : payload.data;
            if (run && "status" in run) onRun(run);
        } catch {
            // A malformed event is ignored; the next snapshot remains authoritative.
        }
    };
    source.addEventListener("workflow.snapshot", handle);
    source.onerror = () => undefined;
    return () => source.close();
}

export function getVozebCmsWorkflowRun(runId: string) {
    return request<{ run: VozebCmsWorkflowRun }>(`/api/vozeb-cms/workflows/runs/${encodeURIComponent(runId)}`).then((data) => data.run);
}

export function controlVozebCmsWorkflowRun(runId: string, action: "pause" | "resume" | "cancel" | "retry") {
    return request<{ run: VozebCmsWorkflowRun }>(`/api/vozeb-cms/workflows/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" }).then((data) => data.run);
}

export function reviewVozebCmsWorkflowNode(runId: string, nodeId: string, decision: "approved" | "rejected") {
    return request<{ run: VozebCmsWorkflowRun }>(`/api/vozeb-cms/workflows/runs/${encodeURIComponent(runId)}/review`, { method: "POST", body: JSON.stringify({ nodeId, decision }) }).then((data) => data.run);
}

async function request<T>(url: string, init: RequestInit = {}) {
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) }, cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload || !payload.data) throw new Error(payload?.msg || "工作流请求失败");
    return payload.data;
}
