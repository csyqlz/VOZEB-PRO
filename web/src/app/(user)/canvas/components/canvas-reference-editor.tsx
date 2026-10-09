"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type CSSProperties } from "react";
import { EditorContent, Node, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import { canvasThemes } from "@/lib/canvas-theme";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { handleMentionNavigation } from "../utils/canvas-mention-navigation";
import { canvasResourceMentionAtCursor, MentionMenu } from "./canvas-resource-mention-textarea";

const Reference = Node.create({
    name: "canvasReference",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes: () => ({ nodeId: { default: "" }, label: { default: "" }, title: { default: "" }, kind: { default: "image" }, previewUrl: { default: "" } }),
    renderText: ({ node }) => node.attrs.label,
    renderHTML({ node }) {
        const attrs = node.attrs;
        const preview =
            attrs.previewUrl && (attrs.kind === "image" || attrs.kind === "video")
                ? [
                      attrs.kind === "image" ? "img" : "video",
                      {
                          src: attrs.kind === "image" ? imagePreviewUrl(attrs.previewUrl, 64) : attrs.previewUrl,
                          alt: "",
                          "aria-hidden": "true",
                          draggable: "false",
                          ...(attrs.kind === "video" ? { muted: "", playsinline: "", preload: "metadata" } : {}),
                          class: "inline-block size-[1.2em] shrink-0 rounded-sm object-cover",
                      },
                  ]
                : ["span", { "aria-hidden": "true" }, "▧"];
        return [
            "span",
            {
                "data-canvas-resource-reference": attrs.nodeId,
                title: attrs.title,
                contenteditable: "false",
                class: "mx-0.5 inline-flex items-center gap-1 rounded-md bg-[#2f80ff]/12 px-1 py-0.5 align-baseline font-medium text-[#2f80ff] ring-1 ring-[#2f80ff]/24",
            },
            preview,
            ["span", {}, attrs.label],
        ];
    },
});

export type CanvasReferenceEditorHandle = { focus: () => void };
type Props = {
    value: string;
    references: CanvasResourceReference[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    autoFocus?: boolean;
    className?: string;
    style?: CSSProperties;
    placeholder?: string;
    "aria-label"?: string;
    "data-canvas-prompt-scroll"?: string;
};
type ActiveMention = { from: number; to: number; query: string };

export function referencePromptDocument(value: string, references: CanvasResourceReference[]): JSONContent {
    const active = new Map(references.filter((item) => item.active).map((item) => [item.label, item]));
    const labels = [...active.keys()].sort((a, b) => b.length - a.length);
    const pattern = labels.length ? new RegExp(`(${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g") : null;
    return {
        type: "doc",
        content: value.split("\n").map((line) => ({
            type: "paragraph",
            content: (pattern ? line.split(pattern) : [line]).filter(Boolean).map((part) => {
                const reference = active.get(part);
                return reference ? { type: "canvasReference", attrs: reference } : { type: "text", text: part };
            }),
        })),
    };
}

function promptText(editor: Editor) {
    return editor.getText({ blockSeparator: "\n" });
}

export const CanvasReferenceEditor = forwardRef<CanvasReferenceEditorHandle, Props>(function CanvasReferenceEditor({ value, references, onChange, onSubmit, autoFocus, className, style, placeholder, ...attributes }, ref) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [mention, setMention] = useState<ActiveMention | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
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
            Reference,
        ],
        [],
    );
    const candidates = useMemo(() => references.filter((item) => item.active && (!mention?.query || `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(mention.query.toLowerCase()))), [references, mention?.query]);
    const syncMention = (current: Editor) => {
        if (current.view.composing) return;
        const { $from, from, empty } = current.state.selection;
        const before = $from.parent.textBetween(0, $from.parentOffset, "\n", (node) => node.attrs.label || "");
        const found = empty ? canvasResourceMentionAtCursor(before, before.length) : undefined;
        setMention(found ? { from: from - (before.length - found.start), to: from, query: found.query } : null);
        setActiveIndex(0);
    };
    const editor = useEditor({
        immediatelyRender: false,
        extensions,
        content: referencePromptDocument(value, references),
        editorProps: {
            attributes: {
                role: "textbox",
                "aria-multiline": "true",
                "aria-label": attributes["aria-label"] || "提示词",
                "data-canvas-no-drag": "",
                "data-canvas-prompt-scroll": attributes["data-canvas-prompt-scroll"] || "node",
                "data-placeholder": placeholder || "",
                class: `${className || ""} whitespace-pre-wrap break-words [&_p]:m-0 [&_p]:min-h-[1em] [&[data-empty=true]]:before:pointer-events-none [&[data-empty=true]]:before:absolute [&[data-empty=true]]:before:opacity-50 [&[data-empty=true]]:before:content-[attr(data-placeholder)]`,
            },
            handleKeyDown: (_view, event) => {
                if (event.isComposing || event.keyCode === 229) return false;
                if (mention && handleMentionNavigation(event, candidates, activeIndex, setActiveIndex, insertReference, () => setMention(null))) return true;
                if (event.key === "Enter" && onSubmit && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    onSubmit();
                    return true;
                }
                return false;
            },
        },
        onCreate: ({ editor: current }) => {
            current.view.dom.dataset.empty = String(current.isEmpty);
            if (autoFocus) current.commands.focus("end");
        },
        onUpdate: ({ editor: current }) => {
            current.view.dom.dataset.empty = String(current.isEmpty);
            onChange(promptText(current));
            syncMention(current);
        },
        onSelectionUpdate: ({ editor: current }) => syncMention(current),
        onBlur: () => setMention(null),
    });
    function insertReference(reference: CanvasResourceReference) {
        if (!editor || !mention) return;
        editor
            .chain()
            .focus()
            .insertContentAt({ from: mention.from, to: mention.to }, [
                { type: "canvasReference", attrs: reference },
                { type: "text", text: " " },
            ])
            .run();
        setMention(null);
    }
    useImperativeHandle(
        ref,
        () => ({
            focus: () => {
                editor?.commands.focus("end");
            },
        }),
        [editor],
    );
    useEffect(() => {
        if (editor && promptText(editor) !== value && !editor.view.composing) {
            editor.commands.setContent(referencePromptDocument(value, references), { emitUpdate: false });
            editor.view.dom.dataset.empty = String(editor.isEmpty);
        }
    }, [editor, value, references]);
    useEffect(() => {
        if (!editor) return;
        Object.assign(editor.view.dom.style, style, { caretColor: style?.color || theme.node.text });
    }, [editor, style, theme.node.text]);
    return (
        <>
            <EditorContent editor={editor} className="relative w-full" />
            {editor && mention && candidates.length ? <MentionMenu textarea={editor.view.dom} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} /> : null}
        </>
    );
});
