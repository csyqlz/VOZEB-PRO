"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type JSONContent, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Popover } from "antd";
import { X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasAgentMentionAtCursor, canvasAgentMentionCandidates, canvasAgentMentionSegments, canvasAgentReferenceAliases, type CanvasAgentMentionAsset } from "./canvas-agent-mention";
import { CanvasAgentMentionPicker } from "./canvas-agent-mention-picker";

function ReferenceChip({ node, deleteNode }: NodeViewProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <NodeViewWrapper
            as="span"
            contentEditable={false}
            data-canvas-agent-reference={node.attrs.id}
            className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border px-1 align-middle text-sm leading-7"
            style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
            title={node.attrs.title}
        >
            {node.attrs.type === "video" ? (
                <video src={node.attrs.url} muted playsInline preload="metadata" className="inline-block size-5 shrink-0 rounded object-cover" />
            ) : (
                <img src={imagePreviewUrl(node.attrs.url, 64)} alt="" className="inline-block size-5 shrink-0 rounded object-cover" />
            )}
            <span className="truncate">{node.attrs.label}</span>
            <button
                type="button"
                aria-label={`移除参考素材：${node.attrs.title}`}
                className="group/remove inline-flex size-7 shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-2"
                onMouseDown={(event) => event.preventDefault()}
                onClick={deleteNode}
                style={
                    {
                        "--remove-surface": theme.node.removeSurface,
                        "--remove-border": theme.node.removeBorder,
                        "--remove-text": theme.node.removeText,
                        "--remove-hover-surface": theme.node.dangerSurface,
                        "--remove-hover-border": theme.node.dangerBorder,
                        "--remove-hover-text": theme.node.danger,
                        outlineColor: theme.node.dangerBorder,
                    } as React.CSSProperties
                }
            >
                <span className="grid size-4 place-items-center rounded-full border border-[var(--remove-border)] bg-[var(--remove-surface)] text-[var(--remove-text)] transition-colors group-hover/remove:border-[var(--remove-hover-border)] group-hover/remove:bg-[var(--remove-hover-surface)] group-hover/remove:text-[var(--remove-hover-text)] group-focus-visible/remove:border-[var(--remove-hover-border)] group-focus-visible/remove:bg-[var(--remove-hover-surface)] group-focus-visible/remove:text-[var(--remove-hover-text)]">
                    <X className="size-2" aria-hidden />
                </span>
            </button>
        </NodeViewWrapper>
    );
}

const AgentReference = Node.create({
    name: "agentReference",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes: () => ({ id: { default: "" }, title: { default: "" }, label: { default: "" }, url: { default: "" }, type: { default: "image" } }),
    renderText: ({ node }) => `@${node.attrs.label}`,
    renderHTML: ({ node }) => ["span", { "data-agent-reference": node.attrs.id }, `@${node.attrs.label}`],
    addNodeView: () => ReactNodeViewRenderer(ReferenceChip),
});

function referenceIds(editor: Editor) {
    const ids = new Set<string>();
    editor.state.doc.descendants((node) => {
        if (node.type.name === "agentReference") ids.add(node.attrs.id);
    });
    return [...ids];
}
function serialize(editor: Editor, assets: CanvasAgentMentionAsset[], ids: string[]) {
    const aliases = canvasAgentReferenceAliases(assets, ids);
    return editor.getText({ blockSeparator: "\n", textSerializers: { agentReference: ({ node }) => `@${aliases.get(node.attrs.id) || node.attrs.label}` } });
}
function promptDocument(prompt: string, assets: CanvasAgentMentionAsset[], ids: string[]): JSONContent {
    const aliases = canvasAgentReferenceAliases(assets, ids);
    return {
        type: "doc",
        content: prompt.split("\n").map((line) => ({
            type: "paragraph",
            content: canvasAgentMentionSegments(line, aliases).map((segment) => {
                const asset = segment.nodeId && assets.find((item) => item.id === segment.nodeId);
                return asset ? { type: "agentReference", attrs: { ...asset, label: aliases.get(asset.id) } } : { type: "text", text: segment.text };
            }),
        })),
    };
}

type Props = {
    prompt: string;
    assets: CanvasAgentMentionAsset[];
    selectedIds: string[];
    placeholder: string;
    onChange: (prompt: string) => void;
    onReferenceIdsChange?: (ids: string[]) => void;
    onSubmit: () => void;
    onAddFiles?: (files: File[]) => void | Promise<void>;
};

export function CanvasAgentPromptEditor({ prompt, assets, selectedIds, placeholder, onChange, onReferenceIdsChange, onSubmit, onAddFiles }: Props) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [mention, setMention] = useState<{ from: number; to: number; query: string } | null>(null);
    const synchronizing = useRef(false);
    const lastEmitted = useRef(prompt);
    const lastProp = useRef(prompt);
    const extensions = useMemo(
        () => [
            StarterKit.configure({
                heading: false,
                blockquote: false,
                bulletList: false,
                orderedList: false,
                listItem: false,
                codeBlock: false,
                horizontalRule: false,
                bold: false,
                italic: false,
                strike: false,
                code: false,
                link: false,
                underline: false,
            }),
            AgentReference,
        ],
        [],
    );
    const candidates = useMemo(() => canvasAgentMentionCandidates(assets, mention?.query || ""), [assets, mention?.query]);
    const syncMention = (current: Editor) => {
        if (current.view.composing) return;
        const { $from, from, empty } = current.state.selection;
        const before = $from.parent.textBetween(0, $from.parentOffset, "\n", (node) => `@${node.attrs.label}`);
        const match = empty ? canvasAgentMentionAtCursor(before, before.length) : undefined;
        setMention(match ? { from: from - (before.length - match.start), to: from, query: match.query } : null);
    };
    const emit = (current: Editor) => {
        const present = referenceIds(current);
        const ids = [...selectedIds.filter((id) => present.includes(id)), ...present.filter((id) => !selectedIds.includes(id))];
        const value = serialize(current, assets, ids);
        lastEmitted.current = value;
        if (ids.join("|") !== selectedIds.join("|")) onReferenceIdsChange?.(ids);
        onChange(value);
        current.view.dom.dataset.empty = String(current.isEmpty);
    };
    const editor = useEditor({
        immediatelyRender: false,
        extensions,
        content: promptDocument(prompt, assets, selectedIds),
        editorProps: {
            attributes: {
                role: "textbox",
                "aria-label": placeholder,
                "aria-multiline": "true",
                "data-placeholder": placeholder,
                "data-canvas-agent-rich-input": "",
                class: "thin-scrollbar min-h-20 w-full overflow-y-auto overscroll-contain break-words whitespace-pre-wrap border-0 bg-transparent px-1 py-1 text-sm leading-7 outline-none [&_p]:m-0 [&_p]:min-h-[1em] [&[data-empty=true]]:before:pointer-events-none [&[data-empty=true]]:before:absolute [&[data-empty=true]]:before:opacity-45 [&[data-empty=true]]:before:content-[attr(data-placeholder)]",
            },
            handlePaste: (_view, event) => {
                if (!onAddFiles || !event.clipboardData) return false;
                const files = clipboardImageFiles(event.clipboardData);
                if (!files.length) return false;
                void onAddFiles(files);
                return true;
            },
            handleKeyDown: (_view, event) => {
                if (event.isComposing || event.keyCode === 229) return false;
                if (event.key === "Escape" && mention) {
                    setMention(null);
                    return true;
                }
                if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return false;
                event.preventDefault();
                if (mention && candidates.length) insertReference(candidates[0]);
                else onSubmit();
                return true;
            },
        },
        onCreate: ({ editor: current }) => {
            current.view.dom.dataset.empty = String(current.isEmpty);
        },
        onUpdate: ({ editor: current }) => {
            if (!synchronizing.current) {
                emit(current);
                syncMention(current);
            }
        },
        onSelectionUpdate: ({ editor: current }) => {
            if (!synchronizing.current) syncMention(current);
        },
    });
    function insertReference(asset: CanvasAgentMentionAsset) {
        if (!editor || !mention) return;
        const ids = selectedIds.includes(asset.id) ? selectedIds : [...selectedIds, asset.id];
        editor
            .chain()
            .focus()
            .insertContentAt({ from: mention.from, to: mention.to }, [
                { type: "agentReference", attrs: { ...asset, label: canvasAgentReferenceAliases(assets, ids).get(asset.id) } },
                { type: "text", text: " " },
            ])
            .run();
        setMention(null);
    }
    useEffect(() => {
        if (!editor || editor.view.composing) return;
        synchronizing.current = true;
        try {
            const externalTextChanged = prompt !== lastProp.current && prompt !== lastEmitted.current;
            lastProp.current = prompt;
            if (externalTextChanged) editor.commands.setContent(promptDocument(prompt, assets, selectedIds), { emitUpdate: false });
            const aliases = canvasAgentReferenceAliases(assets, selectedIds);
            let tr = editor.state.tr;
            editor.state.doc.descendants((node, pos) => {
                if (node.type.name !== "agentReference") return;
                const asset = assets.find((item) => item.id === node.attrs.id);
                if (!asset || !aliases.has(asset.id)) tr = tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
                else if (node.attrs.label !== aliases.get(asset.id) || node.attrs.url !== asset.url || node.attrs.title !== asset.title) tr = tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...asset, label: aliases.get(asset.id) });
            });
            if (tr.docChanged) editor.view.dispatch(tr);
            const present = referenceIds(editor);
            const missing = selectedIds
                .filter((id) => !present.includes(id))
                .flatMap((id) => {
                    const asset = assets.find((item) => item.id === id);
                    return asset
                        ? [
                              { type: "agentReference", attrs: { ...asset, label: aliases.get(id) } },
                              { type: "text", text: " " },
                          ]
                        : [];
                });
            if (missing.length) editor.commands.insertContent(missing);
            editor.view.dom.dataset.empty = String(editor.isEmpty);
            const value = serialize(editor, assets, selectedIds);
            if (value !== prompt) {
                lastEmitted.current = value;
                onChange(value);
            }
        } finally {
            synchronizing.current = false;
        }
    }, [editor, prompt, assets, selectedIds, onChange]);
    useEffect(() => {
        if (!editor) return;
        Object.assign(editor.view.dom.style, { color: theme.node.text, caretColor: theme.node.text, maxHeight: "40dvh" });
    }, [editor, theme.node.text]);
    return (
        <Popover
            trigger={[]}
            placement="topLeft"
            arrow={false}
            open={mention !== null}
            onOpenChange={(open) => {
                if (!open) setMention(null);
            }}
            styles={{ container: { padding: 0, borderRadius: 12, overflow: "hidden", background: theme.node.panel, border: `1px solid ${theme.toolbar.border}` } }}
            content={<CanvasAgentMentionPicker assets={candidates} selectedNodeIds={selectedIds} theme={theme} onSelect={insertReference} />}
        >
            <div className="relative min-w-0 w-full">
                <EditorContent editor={editor} />
            </div>
        </Popover>
    );
}
