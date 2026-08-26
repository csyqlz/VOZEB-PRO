"use client";

import { App, Button, Checkbox, Form, Input, Modal, Segmented, Select, Tag } from "antd";
import { Check, Film, Image as ImageIcon, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatBytes } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import {
    createWorkPublication,
    getWorkPublication,
    getWorkPublicationSource,
    listWorkPublicationSources,
    updateWorkPublication,
    type WorkPublication,
    type WorkPublicationAuthorDisplay,
    type WorkPublicationDraftInput,
    type WorkPublicationSource,
    type WorkPublicationSourcePage,
    type WorkPublicationSourceSummary,
    type WorkPublicationSourceType,
    type WorkPublicationVisibility,
} from "@/services/api/work-publications";
import { SOURCE_TYPE_LABELS, VISIBILITY_LABELS, WORK_CATEGORY_OPTIONS } from "../work-publication-values";

type EditorValues = {
    sourceType: WorkPublicationSourceType;
    sourceId: string;
    title: string;
    description: string;
    publicPrompt: string;
    category: string;
    tags: string[];
    visibility: WorkPublicationVisibility;
    authorDisplay: WorkPublicationAuthorDisplay;
    authorName?: string;
};

type SourceListState = WorkPublicationSourcePage & { keyword: string; loaded: boolean; loading: boolean };

const emptySourceList = (): SourceListState => ({ items: [], total: 0, page: 1, pageSize: 0, keyword: "", loaded: false, loading: false });
const emptySourceLists = (): Record<WorkPublicationSourceType, SourceListState> => ({ media: emptySourceList(), canvas: emptySourceList(), drama: emptySourceList() });

export function WorkPublicationEditor({
    open,
    workId,
    initialSource,
    onCancel,
    onSaved,
}: {
    open: boolean;
    workId?: string;
    initialSource?: { sourceType: WorkPublicationSourceType; sourceId: string };
    onCancel: () => void;
    onSaved: (work: WorkPublication) => void;
}) {
    const { message } = App.useApp();
    const [form] = Form.useForm<EditorValues>();
    const sourceType = Form.useWatch("sourceType", form) || "media";
    const authorDisplay = Form.useWatch("authorDisplay", form) || "profile";
    const visibility = Form.useWatch("visibility", form) || "public";
    const [sourceLists, setSourceLists] = useState(emptySourceLists);
    const [source, setSource] = useState<WorkPublicationSource | null>(null);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [coverKey, setCoverKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [sourceLoading, setSourceLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const sourceListRequestIds = useRef<Record<WorkPublicationSourceType, number>>({ media: 0, canvas: 0, drama: 0 });
    const sourceDetailRequestId = useRef(0);

    const loadSourcePage = useCallback(
        async (nextType: WorkPublicationSourceType, input: { page?: number; keyword?: string; append?: boolean } = {}) => {
            const requestId = ++sourceListRequestIds.current[nextType];
            const page = input.page || 1;
            const keyword = input.keyword?.trim() || "";
            setSourceLists((current) => ({
                ...current,
                [nextType]: {
                    ...(input.append ? current[nextType] : emptySourceList()),
                    keyword,
                    loading: true,
                },
            }));
            try {
                const result = await listWorkPublicationSources({ sourceType: nextType, page, keyword });
                if (sourceListRequestIds.current[nextType] !== requestId) return;
                setSourceLists((current) => ({
                    ...current,
                    [nextType]: {
                        ...result,
                        items: input.append ? mergeSourceSummaries(current[nextType].items, result.items) : result.items,
                        keyword,
                        loaded: true,
                        loading: false,
                    },
                }));
            } catch (error) {
                if (sourceListRequestIds.current[nextType] !== requestId) return;
                setSourceLists((current) => ({ ...current, [nextType]: { ...current[nextType], loaded: true, loading: false } }));
                message.error(error instanceof Error ? error.message : "来源列表加载失败");
            }
        },
        [message],
    );

    useEffect(() => {
        if (!open) return;
        let active = true;
        sourceListRequestIds.current.media += 1;
        sourceListRequestIds.current.canvas += 1;
        sourceListRequestIds.current.drama += 1;
        sourceDetailRequestId.current += 1;
        setLoading(true);
        setSourceLists(emptySourceLists());
        setSource(null);
        setSelectedKeys([]);
        setCoverKey("");
        void (async () => {
            try {
                const work = workId ? await getWorkPublication(workId) : undefined;
                if (!active) return;
                const nextType = work?.sourceType || initialSource?.sourceType || "media";
                const nextSourceId = work?.sourceId || initialSource?.sourceId || "";
                form.setFieldsValue({
                    sourceType: nextType,
                    sourceId: nextSourceId,
                    title: work?.currentVersion?.title || "",
                    description: work?.currentVersion?.description || "",
                    publicPrompt: work?.currentVersion?.publicPrompt || "",
                    category: work?.currentVersion?.category || "其他",
                    tags: work?.currentVersion?.tags || [],
                    visibility: work?.currentVersion?.visibility || "public",
                    authorDisplay: work?.currentVersion?.authorDisplay || "profile",
                    authorName: work?.currentVersion?.authorName,
                });
                const [, detail] = await Promise.all([workId ? Promise.resolve() : loadSourcePage(nextType), nextSourceId ? getWorkPublicationSource(nextType, nextSourceId) : Promise.resolve(undefined)]);
                if (!active) return;
                if (!detail) return;
                setSource(detail);
                const currentAssets = work?.currentAssets || [];
                setSelectedKeys(currentAssets.filter((asset) => asset.role === "content").map((asset) => asset.storageKey));
                setCoverKey(currentAssets.find((asset) => asset.role === "cover")?.storageKey || "");
                if (!work?.currentVersion?.title) form.setFieldValue("title", detail.title);
                if (!work?.currentVersion?.publicPrompt?.trim() && detail.suggestedPrompt) form.setFieldValue("publicPrompt", detail.suggestedPrompt);
            } catch (error) {
                if (active) message.error(error instanceof Error ? error.message : "发布信息加载失败");
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
            sourceListRequestIds.current.media += 1;
            sourceListRequestIds.current.canvas += 1;
            sourceListRequestIds.current.drama += 1;
            sourceDetailRequestId.current += 1;
        };
    }, [form, initialSource?.sourceId, initialSource?.sourceType, loadSourcePage, message, open, workId]);

    const sourceList = sourceLists[sourceType];

    const sourceOptions = useMemo(() => {
        const options = sourceList.items.map((item) => ({
            value: item.id,
            label: `${item.title}${item.kind ? ` · ${SOURCE_TYPE_LABELS.media}${item.kind === "image" ? "图片" : "视频"}` : ""}`,
        }));
        if (source?.sourceType === sourceType && !options.some((item) => item.value === source.sourceId)) options.unshift({ value: source.sourceId, label: source.title });
        return options;
    }, [source, sourceList.items, sourceType]);

    const selectSource = async (nextType: WorkPublicationSourceType, sourceId: string) => {
        const requestId = ++sourceDetailRequestId.current;
        form.setFieldValue("sourceId", sourceId);
        setSource(null);
        setSelectedKeys([]);
        setCoverKey("");
        if (!sourceId) return;
        setSourceLoading(true);
        try {
            const detail = await getWorkPublicationSource(nextType, sourceId);
            if (sourceDetailRequestId.current !== requestId || form.getFieldValue("sourceType") !== nextType || form.getFieldValue("sourceId") !== sourceId) return;
            setSource(detail);
            const keys = detail.candidates.map((candidate) => candidate.storageKey);
            setSelectedKeys(keys);
            setCoverKey(detail.candidates.find((candidate) => candidate.mediaType === "image")?.storageKey || "");
            if (!form.getFieldValue("title")) form.setFieldValue("title", detail.title);
            if (!form.getFieldValue("publicPrompt")?.trim() && detail.suggestedPrompt) form.setFieldValue("publicPrompt", detail.suggestedPrompt);
        } catch (error) {
            if (sourceDetailRequestId.current !== requestId) return;
            message.error(error instanceof Error ? error.message : "来源加载失败");
        } finally {
            if (sourceDetailRequestId.current === requestId) setSourceLoading(false);
        }
    };

    const save = async (values: EditorValues) => {
        if (!source || !selectedKeys.length) return message.warning("请至少选择一个作品媒体");
        setSaving(true);
        try {
            const input: WorkPublicationDraftInput = {
                ...values,
                sourceType: source.sourceType,
                sourceId: source.sourceId,
                title: values.title.trim(),
                description: values.description?.trim() || "",
                publicPrompt: values.publicPrompt.trim(),
                tags: values.tags || [],
                authorName: values.authorName?.trim() || undefined,
                coverStorageKey: coverKey || undefined,
                assetStorageKeys: selectedKeys,
            };
            const work = workId ? await updateWorkPublication(workId, input) : await createWorkPublication(input);
            message.success(workId ? "作品草稿已保存" : "作品草稿已创建");
            onSaved(work);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "作品保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title={workId ? "编辑发布版本" : "发布新作品"}
            open={open}
            width={900}
            okText="保存草稿"
            cancelText="取消"
            confirmLoading={saving}
            okButtonProps={{ disabled: loading || sourceLoading || !source || !selectedKeys.length }}
            mask={{ closable: !saving }}
            keyboard={!saving}
            destroyOnHidden
            onOk={() => form.submit()}
            onCancel={onCancel}
        >
            {loading ? (
                <div className="grid min-h-72 place-items-center text-sm text-stone-500 dark:text-stone-400">
                    <span className="flex items-center gap-2">
                        <LoaderCircle className="size-4 animate-spin" /> 正在加载发布信息
                    </span>
                </div>
            ) : (
                <Form form={form} layout="vertical" requiredMark={false} onFinish={(values) => void save(values)}>
                    <div className="max-h-[min(70dvh,760px)] min-w-0 space-y-4 overflow-y-auto pr-1">
                        <section className="rounded-lg border border-stone-200 p-3 sm:p-4 dark:border-stone-800">
                            <div className="mb-3 text-sm font-semibold text-stone-950 dark:text-stone-100">选择发布来源</div>
                            <div className="grid gap-x-4 sm:grid-cols-[220px_minmax(0,1fr)]">
                                <Form.Item label="来源类型" name="sourceType" rules={[{ required: true }]}>
                                    <Segmented
                                        block
                                        disabled={Boolean(workId)}
                                        options={Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
                                        onChange={(value) => {
                                            const nextType = value as WorkPublicationSourceType;
                                            sourceDetailRequestId.current += 1;
                                            form.setFieldsValue({ sourceType: nextType, sourceId: "" });
                                            setSource(null);
                                            setSelectedKeys([]);
                                            setCoverKey("");
                                            setSourceLoading(false);
                                            void loadSourcePage(nextType);
                                        }}
                                    />
                                </Form.Item>
                                <Form.Item label="具体来源" name="sourceId" rules={[{ required: true, message: "请选择发布来源" }]}>
                                    <Select
                                        key={sourceType}
                                        showSearch
                                        disabled={Boolean(workId)}
                                        filterOption={false}
                                        loading={sourceLoading || sourceList.loading}
                                        notFoundContent={sourceList.loading ? "正在加载" : "暂无可发布来源"}
                                        placeholder="选择本人素材或项目"
                                        options={sourceOptions}
                                        onOpenChange={(nextOpen) => {
                                            if (nextOpen && !sourceList.loaded && !sourceList.loading) void loadSourcePage(sourceType);
                                        }}
                                        onSearch={(keyword) => void loadSourcePage(sourceType, { keyword })}
                                        onPopupScroll={(event) => {
                                            const target = event.currentTarget;
                                            if (Math.ceil(target.scrollTop + target.clientHeight) < target.scrollHeight || sourceList.loading || sourceList.items.length >= sourceList.total) return;
                                            void loadSourcePage(sourceType, { page: sourceList.page + 1, keyword: sourceList.keyword, append: true });
                                        }}
                                        onChange={(value) => void selectSource(sourceType, value)}
                                    />
                                </Form.Item>
                            </div>
                        </section>

                        <section className="rounded-lg border border-stone-200 p-3 sm:p-4 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">作品媒体</div>
                                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">已选 {selectedKeys.length} 项，图片可设为分享封面</div>
                                </div>
                                {sourceLoading ? <LoaderCircle className="size-4 animate-spin text-stone-400" /> : null}
                            </div>
                            {source?.candidates.length ? (
                                <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                                    {source.candidates.map((candidate) => {
                                        const selected = selectedKeys.includes(candidate.storageKey);
                                        const cover = coverKey === candidate.storageKey;
                                        return (
                                            <article key={candidate.storageKey} className={`min-w-0 overflow-hidden rounded-md border ${selected ? "border-stone-950 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
                                                <div className="relative aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-stone-900">
                                                    {candidate.mediaType === "image" ? (
                                                        <img src={imagePreviewUrl(candidate.previewUrl, 320)} alt={candidate.originalName} className="size-full object-cover" loading="lazy" />
                                                    ) : candidate.mediaType === "video" ? (
                                                        <video src={candidate.previewUrl} className="size-full object-cover" preload="metadata" muted />
                                                    ) : null}
                                                    <Checkbox
                                                        className="!absolute !left-2 !top-2 !m-0 [&_.ant-checkbox-inner]:!size-5 [&_.ant-checkbox-inner]:!border-white/90 [&_.ant-checkbox-inner]:!bg-white/95 [&_.ant-checkbox-checked_.ant-checkbox-inner]:!border-stone-950 [&_.ant-checkbox-checked_.ant-checkbox-inner]:!bg-stone-950 dark:[&_.ant-checkbox-inner]:!border-stone-700 dark:[&_.ant-checkbox-inner]:!bg-stone-900 dark:[&_.ant-checkbox-checked_.ant-checkbox-inner]:!border-white dark:[&_.ant-checkbox-checked_.ant-checkbox-inner]:!bg-white dark:[&_.ant-checkbox-checked_.ant-checkbox-inner]:after:!border-stone-950"
                                                        checked={selected}
                                                        aria-label={`选择 ${candidate.originalName}`}
                                                        onChange={(event) => setSelectedKeys((keys) => (event.target.checked ? [...new Set([...keys, candidate.storageKey])] : keys.filter((key) => key !== candidate.storageKey)))}
                                                    />
                                                    <Tag className="!absolute !bottom-1.5 !right-1.5 !m-0 !border-0 !bg-black/65 !text-[10px] !text-white">
                                                        {candidate.mediaType === "image" ? <ImageIcon className="mr-1 inline size-3" /> : candidate.mediaType === "video" ? <Film className="mr-1 inline size-3" /> : null}
                                                        {formatBytes(candidate.bytes)}
                                                    </Tag>
                                                </div>
                                                <div className="min-w-0 p-2">
                                                    <div className="truncate text-xs font-medium text-stone-800 dark:text-stone-200" title={candidate.originalName}>
                                                        {candidate.originalName}
                                                    </div>
                                                    {candidate.mediaType === "image" ? (
                                                        <Button type={cover ? "primary" : "text"} size="small" className="!mt-1.5 !h-7 !w-full" icon={cover ? <Check className="size-3.5" /> : undefined} onClick={() => setCoverKey(candidate.storageKey)}>
                                                            {cover ? "当前封面" : "设为封面"}
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="mt-3 grid min-h-24 place-items-center rounded-md border border-dashed border-stone-300 px-3 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">选择来源后加载可发布媒体</div>
                            )}
                        </section>

                        <section className="rounded-lg border border-stone-200 p-3 sm:p-4 dark:border-stone-800">
                            <div className="grid gap-x-4 sm:grid-cols-2">
                                <Form.Item label="作品标题" name="title" rules={[{ required: true, message: "请输入作品标题" }, { max: 100 }]}>
                                    <Input placeholder="清楚说明作品内容" maxLength={100} />
                                </Form.Item>
                                <Form.Item label="分类" name="category" rules={[{ required: true }]}>
                                    <Select options={WORK_CATEGORY_OPTIONS} />
                                </Form.Item>
                            </div>
                            <Form.Item label="作品说明" name="description" rules={[{ max: 2000 }]}>
                                <Input.TextArea rows={4} maxLength={2000} showCount placeholder="说明创作主题、内容和适合的观看方式" />
                            </Form.Item>
                            <Form.Item label="作品提示词" name="publicPrompt" rules={[{ required: true, whitespace: true, message: "请填写作品提示词" }, { max: 8000 }]} extra="选择来源后会自动读取项目中可见的创作提示词；你可以在发布前继续修改。">
                                <Input.TextArea rows={5} maxLength={8000} showCount placeholder="填写观众可查看、复制和用于做同款的提示词" />
                            </Form.Item>
                            <Form.Item label="标签" name="tags">
                                <Select mode="tags" maxCount={10} maxTagCount="responsive" tokenSeparators={[",", "，"]} placeholder="输入标签后回车，最多 10 个" />
                            </Form.Item>
                            <div className="grid gap-x-4 sm:grid-cols-2">
                                <Form.Item label="可见范围" name="visibility" rules={[{ required: true }]}>
                                    <Select options={Object.entries(VISIBILITY_LABELS).map(([value, label]) => ({ value, label }))} />
                                </Form.Item>
                                <Form.Item label="作者显示" name="authorDisplay" rules={[{ required: true }]}>
                                    <Select
                                        options={[
                                            { value: "profile", label: "使用个人资料昵称" },
                                            { value: "custom", label: "使用自定义作者名" },
                                            { value: "hidden", label: "不显示作者" },
                                        ]}
                                    />
                                </Form.Item>
                            </div>
                            <p className={`-mt-2 mb-4 text-xs leading-5 ${visibility === "public" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                                {visibility === "public" ? "审核通过后会进入作品广场，并可通过分享链接访问。" : visibility === "unlisted" ? "审核通过后仅持链接可访问，不会出现在作品广场。" : "仅自己可见，不会生成公开分享页面，也不会进入作品广场。"}
                            </p>
                            {authorDisplay === "custom" ? (
                                <Form.Item label="展示作者名" name="authorName" rules={[{ required: true, message: "请输入展示作者名" }, { max: 80 }]}>
                                    <Input maxLength={80} placeholder="只在公开作品中展示" />
                                </Form.Item>
                            ) : null}
                        </section>
                    </div>
                </Form>
            )}
        </Modal>
    );
}

function mergeSourceSummaries(current: WorkPublicationSourceSummary[], next: WorkPublicationSourceSummary[]) {
    const merged = new Map(current.map((item) => [item.id, item]));
    next.forEach((item) => merged.set(item.id, item));
    return [...merged.values()];
}
