import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { autoLayoutCanvas, isAgentInternalNode } from "./canvas-auto-layout";

const node = (id: string, type: CanvasNodeType, x = 0, y = 0, width = 240, height = 140): CanvasNodeData => ({ id, type, title: id, position: { x, y }, width, height, metadata: {} });

describe("Canvas 一键整理", () => {
    it("按连接拓扑分列并保留节点身份与连接", () => {
        const nodes = [node("prompt", CanvasNodeType.Text, 900, 700), node("config", CanvasNodeType.Config, -300, 20), node("result", CanvasNodeType.Image, 10, -600)];
        const arranged = autoLayoutCanvas(nodes, [
            { id: "edge", fromNodeId: "prompt", toNodeId: "result" },
            { id: "edge-2", fromNodeId: "config", toNodeId: "result" },
        ]);
        expect(arranged.map((item) => item.id)).toEqual(["prompt", "config", "result"]);
        expect(arranged.find((item) => item.id === "prompt")!.position.x).toBeLessThan(arranged.find((item) => item.id === "result")!.position.x);
        expect(arranged.find((item) => item.id === "config")!.position.x).toBeLessThan(arranged.find((item) => item.id === "result")!.position.x);
        expect(arranged.map((item) => item.position)).not.toEqual(nodes.map((item) => item.position));
    });

    it("不移动 Agent 内部节点，并将其标记为默认隐藏", () => {
        const internal = { ...node("brief", CanvasNodeType.Brief), metadata: { agentRunId: "run" } };
        const agentTask = { ...node("agent-task", CanvasNodeType.Task, 320, 180), metadata: { agentRunId: "run" } };
        const manualTask = node("manual-task", CanvasNodeType.Task);
        const result = autoLayoutCanvas([internal, agentTask, manualTask], []);
        expect(result[0].position).toEqual(internal.position);
        expect(result[1].position).toEqual(agentTask.position);
        expect(isAgentInternalNode(internal)).toBe(true);
        expect(isAgentInternalNode(agentTask)).toBe(true);
        expect(isAgentInternalNode(manualTask)).toBe(false);
        expect(isAgentInternalNode({ ...node("result", CanvasNodeType.Image), metadata: { agentRunId: "run" } })).toBe(false);
    });

    it("穿透隐藏 Agent 任务恢复可见输入与结果的布局关系", () => {
        const source = node("source", CanvasNodeType.Image, 640, 420);
        const hiddenTask = { ...node("agent-task", CanvasNodeType.Task, -320, -180), metadata: { agentRunId: "run" } };
        const output = { ...node("output", CanvasNodeType.Image, 40, 720), metadata: { agentRunId: "run" } };
        const arranged = autoLayoutCanvas(
            [source, hiddenTask, output],
            [
                { id: "source-task", fromNodeId: source.id, toNodeId: hiddenTask.id },
                { id: "task-output", fromNodeId: hiddenTask.id, toNodeId: output.id },
            ],
            { width: 1200, height: 720 },
        );

        expect(arranged.find((item) => item.id === hiddenTask.id)?.position).toEqual(hiddenTask.position);
        expect(arranged.find((item) => item.id === output.id)!.position.x).toBeGreaterThan(arranged.find((item) => item.id === source.id)!.position.x);
    });

    it("长链路不把节点压回固定列，孤立节点按语义分层", () => {
        const nodes = Array.from({ length: 6 }, (_, index) => node(`node-${index}`, index === 0 ? CanvasNodeType.Text : CanvasNodeType.Image, 900 - index * 40, 700 - index * 80));
        const connections = nodes.slice(0, -1).map((item, index) => ({ id: `edge-${index}`, fromNodeId: item.id, toNodeId: nodes[index + 1].id }));
        const arranged = autoLayoutCanvas(nodes, connections);
        expect(new Set(arranged.map((item) => item.position.x)).size).toBe(6);
        expect(arranged.map((item) => item.position.y)).toEqual([96, 96, 96, 96, 96, 96]);
        const isolated = autoLayoutCanvas([node("text", CanvasNodeType.Text), node("config", CanvasNodeType.Config), node("image", CanvasNodeType.Image)], []);
        expect(isolated.find((item) => item.id === "text")!.position.x).toBeLessThan(isolated.find((item) => item.id === "config")!.position.x);
        expect(isolated.find((item) => item.id === "config")!.position.x).toBeLessThan(isolated.find((item) => item.id === "image")!.position.x);
    });

    it("大量独立生成分支整理后仍保持稳定且分行紧凑", () => {
        const sources = Array.from({ length: 80 }, (_, index) => node(`source-${index}`, CanvasNodeType.Image, index * 900, index * 20));
        const outputs = sources.map((source, index) => node(`output-${index}`, CanvasNodeType.Image, source.position.x + 500, source.position.y + 240));
        const nodes = sources.concat(outputs);
        const connections = sources.map((source, index) => ({ id: `edge-${index}`, fromNodeId: source.id, toNodeId: outputs[index].id }));
        const first = autoLayoutCanvas(nodes, connections, { width: 1800, height: 1000 });
        const second = autoLayoutCanvas(first, connections, { width: 1800, height: 1000 });

        expect(second.map((item) => item.position)).toEqual(first.map((item) => item.position));
        expect(new Set(first.map((item) => item.position.y)).size).toBeGreaterThan(1);
    });

    it("全部是内部节点时保持原布局", () => {
        const internal = { ...node("brief", CanvasNodeType.Brief, 420, 180), metadata: { agentRunId: "run" } };
        expect(autoLayoutCanvas([internal], []).at(0)?.position).toEqual(internal.position);
    });

    it("将旧坐标互相穿插的生成分支紧凑整理且互不重叠", () => {
        const nodes = [
            node("pig-source", CanvasNodeType.Image, 80, 40, 260, 220),
            node("pig-cutout", CanvasNodeType.Image, 640, 540, 240, 220),
            node("pig-background", CanvasNodeType.Image, 640, 920, 280, 180),
            node("person-source", CanvasNodeType.Image, 120, 760, 320, 180),
            node("person-cutout", CanvasNodeType.Image, 640, 120, 280, 180),
            node("person-background", CanvasNodeType.Image, 640, 340, 280, 180),
        ];
        const connections = [
            { id: "pig-cutout-edge", fromNodeId: "pig-source", toNodeId: "pig-cutout" },
            { id: "pig-background-edge", fromNodeId: "pig-source", toNodeId: "pig-background" },
            { id: "person-cutout-edge", fromNodeId: "person-source", toNodeId: "person-cutout" },
            { id: "person-background-edge", fromNodeId: "person-source", toNodeId: "person-background" },
        ];

        const arranged = autoLayoutCanvas(nodes, connections, { width: 1400, height: 720 });
        const byId = new Map(arranged.map((item) => [item.id, item]));
        const pigRight = Math.max(...["pig-source", "pig-cutout", "pig-background"].map((id) => byId.get(id)!.position.x + byId.get(id)!.width));
        const personLeft = Math.min(...["person-source", "person-cutout", "person-background"].map((id) => byId.get(id)!.position.x));
        const pigSourceCenter = byId.get("pig-source")!.position.y + byId.get("pig-source")!.height / 2;
        const pigChildrenCenter = (byId.get("pig-cutout")!.position.y + byId.get("pig-background")!.position.y + byId.get("pig-background")!.height) / 2;

        expect(pigRight).toBeLessThan(personLeft);
        expect(pigSourceCenter).toBe(pigChildrenCenter);
        expect(byId.get("pig-cutout")!.position.y).toBeLessThan(byId.get("pig-background")!.position.y);
        expect(byId.get("person-cutout")!.position.y).toBeLessThan(byId.get("person-background")!.position.y);
    });

    it("循环图和多父节点重复整理后保持稳定", () => {
        const nodes = [node("cycle-a", CanvasNodeType.Text, 720, 520), node("cycle-b", CanvasNodeType.Image, 80, 260), node("cycle-c", CanvasNodeType.Image, 460, 40), node("result", CanvasNodeType.Image, 920, 120)];
        const connections = [
            { id: "a-b", fromNodeId: "cycle-a", toNodeId: "cycle-b" },
            { id: "b-c", fromNodeId: "cycle-b", toNodeId: "cycle-c" },
            { id: "c-a", fromNodeId: "cycle-c", toNodeId: "cycle-a" },
            { id: "a-result", fromNodeId: "cycle-a", toNodeId: "result" },
            { id: "c-result", fromNodeId: "cycle-c", toNodeId: "result" },
        ];

        const first = autoLayoutCanvas(nodes, connections);
        const second = autoLayoutCanvas(first, connections);
        const byId = new Map(first.map((item) => [item.id, item]));

        expect(second.map((item) => item.position)).toEqual(first.map((item) => item.position));
        expect(new Set(["cycle-a", "cycle-b", "cycle-c"].map((id) => byId.get(id)!.position.x)).size).toBe(3);
        expect(byId.get("result")!.position.x).toBeGreaterThan(byId.get("cycle-a")!.position.x);
    });
});
