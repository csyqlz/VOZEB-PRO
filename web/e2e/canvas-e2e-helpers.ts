import { expect, type APIRequestContext, type Page } from "@playwright/test";

export function node(id: string, type: string, x: number, y: number, width: number, height: number, metadata: Record<string, unknown>) {
    return { id, type, title: id, position: { x, y }, width, height, metadata };
}

export async function createCanvasProject(request: APIRequestContext, project: Record<string, unknown>) {
    const response = await request.post("/api/canvas/projects", { data: { title: project.title, project } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { id: string } } }).data.project;
}

export async function deleteCanvasProject(request: APIRequestContext, id: string) {
    const response = await request.delete("/api/canvas/projects", { data: { ids: [id] } });
    expect(response.ok(), await response.text()).toBe(true);
}

export async function readCanvasProject(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return (
        (await response.json()) as {
            data: {
                project: {
                    nodes: Array<{
                        id: string;
                        type: string;
                        position: { x: number; y: number };
                        width: number;
                        height: number;
                        metadata?: {
                            videoReferenceMode?: string;
                            videoFirstFrame?: { nodeId?: string };
                            videoLastFrame?: { nodeId?: string };
                            videoReferences?: Array<{ role: string }>;
                            [key: string]: unknown;
                        };
                    }>;
                    chatSessions: Array<{ id: string; title?: string; messages?: unknown[] }>;
                };
            };
        }
    ).data.project;
}

export async function expectCanvasSaved(page: Page, timeout = 5_000) {
    await expect(page.locator(".canvas-topbar")).toHaveAttribute("data-save-status", "saved", { timeout });
}

export async function expectNoHorizontalOverflow(page: Page, label: string) {
    const widths = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(widths.scrollWidth, `${label} document overflow`).toBeLessThanOrEqual(widths.clientWidth + 1);
}
