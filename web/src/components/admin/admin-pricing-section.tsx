"use client";

import { App, AutoComplete, Button, Cascader, Checkbox, Drawer, Dropdown, Empty, Image, Input, Modal, Pagination, Select, Tag } from "antd";
import Decimal from "decimal.js";
import { useEffect, useMemo, useRef, useState } from "react";

import { hasAdminPermission } from "@/lib/admin-permissions";
import type { PublicUser } from "@/lib/auth/store";
import {
    DEEPSEEK_TIME_PRICE_KEYS,
    isMainlandByteDancePrice,
    officialPriceConditionChoices,
    officialPriceDraftIssues,
    officialPriceItemConditionChoices,
    officialPriceObservationVariants,
    officialPriceReferenceItems,
    officialPriceStructureItems,
    officialItemsForTextPriceGroup,
    POINTS_PER_CNY,
    resolveUserPriceCoefficient,
    supportsDeepSeekTimePricing,
    type BusinessExchangeRate,
    type OfficialPriceInput,
    type OfficialPriceDraft,
    type OfficialPriceCatalogEntry,
    type OfficialPriceSource,
    type OfficialPriceVersion,
    type ModelPriceBinding,
    type PriceCandidate,
    type SalesPolicy,
    type UnpricedModelStatus,
    type UserPriceRule,
} from "@/lib/model-pricing";
import type { ReviewedAudioPriceContractInput } from "@/lib/server/model-pricing-audio-contract-store";
import type { ReviewedVideoPriceContractInput } from "@/lib/server/model-pricing-video-contract-store";
import type { VideoPriceContractInput } from "@/lib/server/model-pricing-video-contract";
import type { HailuoPriceContract } from "@/lib/server/model-pricing-hailuo-contract";
import type { ImagePriceContractInput } from "@/lib/server/model-pricing-image-contract";
import type { FlatTextMeter, FlatTextPriceContractInput } from "@/lib/server/model-pricing-token-contract";
import {
    getAudioContractHistory,
    getAudioContractOptions,
    reviewAudioContract,
    type AudioContractHistory,
    type AudioContractOptions,
    getVideoContractHistory,
    getVideoContractOptions,
    reviewVideoContract,
    type VideoContractHistory,
    type VideoContractOptions,
    getImageContractHistory,
    getImageContractOptions,
    reviewImageContract,
    type ImageContractHistory,
    type ImageContractOptions,
    amendOfficialPriceObservation,
    deleteOfficialPriceObservation,
    deleteOfficialPrice,
    editOfficialPrice,
    getFlatTextContractHistory,
    getFlatTextContractOptions,
    getModelPricing,
    getModelPricingActivationStatus,
    getModelPricingSampleUsage,
    revalueSavedImageEvidence,
    revalueSavedTextEvidence,
    setModelPricingActivation,
    createDirectedPricingTask,
    getDirectedPricingTask,
    getDirectedPricingEvidence,
    type DirectedPricingEvidence,
    type DirectedPricingCapability,
    type ModelWorkbenchFilter,
    getOfficialPriceObservations,
    invalidateOfficialPriceObservation,
    getOfficialPriceReferences,
    getOfficialPriceStructureReferences,
    getIndependentOfficialPriceOptions,
    getCurrentModelPriceSelection,
    bindIndependentOfficialPrice,
    revokeIndependentOfficialPrice,
    getOfficialPriceCatalog,
    getOfficialPriceCatalogImpact,
    createOfficialPriceCatalog,
    editOfficialPriceCatalog,
    deleteOfficialPriceCatalog,
    getOfficialPriceReviewLinks,
    previewModelSales,
    publishModelSales,
    reviewFlatTextContract,
    getTextUsageRuleOptions,
    reviewTextUsageRule,
    getTextPricingExceptions,
    reviewOfficialPriceObservation,
    reviewOfficialPrices,
    reviewOfficialPrice,
    saveModelExchangeRate,
    saveOfficialPriceObservation,
    saveOfficialPriceSourceLink,
    setByteDanceSeedRetired,
    submitOfficialPrice,
    unbindModelSalesPrice,
    type FlatTextContractHistory,
    type FlatTextContractOptions,
    type TextUsageRuleOptions,
    type TextPricingExceptions,
    type ModelPricingActivationStatus,
    type ModelPricingOverview,
    type IndependentOfficialPriceOptions,
    type ModelPriceSelection,
    type OfficialPriceObservationPage,
    type PriceReviewProgress,
    type PriceReviewResult,
    type UnpricedModelFilter,
} from "@/services/api/model-pricing";

const emptyPolicy = (): SalesPolicy => ({ priceVersionIds: {}, userPriceRules: [], usdPerCurrency: {}, pointsPerCurrency: {}, rateEvidence: {}, deepSeekUtcWindowModels: [] });
const emptyConversion = (): BusinessExchangeRate => ({ cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "平台业务定价假设：1 USD = 7 CNY；非实时市场汇率" });
const emptyCandidate = (): OfficialPriceInput => ({
    logicalModelId: "",
    manufacturer: "",
    series: "",
    officialVersion: "",
    sku: "",
    tier: "paid",
    conditions: "",
    sourceKind: "manual",
    sourceUrl: "",
    evidence: "",
    observedAt: new Date().toISOString(),
    items: [],
});
type PriceReferences = Awaited<ReturnType<typeof getOfficialPriceReferences>>;
type SalesPreview = Awaited<ReturnType<typeof previewModelSales>>;
type CandidateFilter = { modelId?: string; manufacturer?: string; status?: PriceCandidate["status"] };
type ReviewUiProgress = Omit<PriceReviewProgress, "status"> & { status: PriceReviewProgress["status"] | "failed" };
const reviewStages = [
    { id: "source", label: "读取官网价目" },
    { id: "retirement", label: "检查停用公告" },
    { id: "platform", label: "读取平台价目" },
    { id: "model", label: "默认文本模型核对" },
    { id: "validation", label: "验证官网证据" },
] as const;
const coefficientScopeLabel: Record<string, string> = { model: "具体模型", series: "模型系列", manufacturer: "模型厂商", default: "默认" };
const unpricedStatusLabel: Record<UnpricedModelStatus, string> = { "no-candidate": "无可用价目候选", "pending-review": "候选待审核", "sales-unpublished": "已审核，售价未发布" };
const openAiProcessingTierOptions = ["standard", "batch", "flex", "fast", "ultrafast"].map((value) => ({ value, label: value === "ultrafast" ? "Ultrafast" : value[0].toUpperCase() + value.slice(1) }));
const processingTierLabel = (price: Pick<OfficialPriceInput, "manufacturer" | "processingTier">) => (price.manufacturer === "OpenAI" ? openAiProcessingTierOptions.find((item) => item.value === price.processingTier)?.label || "处理档位未标注" : "");
const capabilityLabels: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const publishedScopeLabels: Record<string, string> = {
    "text:generation:standard": "文本生成",
    "image:generations:standard": "图片生成",
    "image:edits:standard": "图片编辑",
    "video:generation:standard": "视频生成",
    "audio:generateContent:standard": "Gemini 音频生成",
    "audio:chat/completions:standard": "OpenAI 原生音频",
};
const priceReferenceIdentityOf = (price: OfficialPriceDraft) => JSON.stringify([price.logicalModelId, price.capability, price.manufacturer, price.series, price.officialVersion, price.sku, price.tier]);

export function AdminPricingSection({ currentUser }: { currentUser: PublicUser }) {
    const { message, modal } = App.useApp();
    const canReview = hasAdminPermission(currentUser, "upstream.manage");
    const canPublish = hasAdminPermission(currentUser, "billing.manage");
    const [overview, setOverview] = useState<ModelPricingOverview>();
    const [policy, setPolicy] = useState<SalesPolicy>(emptyPolicy);
    const [modelId, setModelId] = useState("");
    const [activeGroup, setActiveGroup] = useState<"workbench" | "official" | "rules">("workbench");
    const [officialSub, setOfficialSub] = useState<"pending" | "approved" | "discovery" | "sources" | "catalog">("pending");
    const [rulesSub, setRulesSub] = useState<"coefficients" | "currency">("coefficients");
    const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
    const [modelDetailView, setModelDetailView] = useState<"overview" | "conditions" | "bindings">("overview");
    const [candidateDetail, setCandidateDetail] = useState<PriceCandidate | null>(null);
    const [approvedDetail, setApprovedDetail] = useState<OfficialPriceVersion | null>(null);
    const [linkTargetModelId, setLinkTargetModelId] = useState("");
    const [workbenchFilter, setWorkbenchFilter] = useState<ModelWorkbenchFilter>({ enabled: "active" });
    const [workbenchSearch, setWorkbenchSearch] = useState("");
    const [activationStatus, setActivationStatus] = useState<ModelPricingActivationStatus>();
    const [textRuleOptions, setTextRuleOptions] = useState<TextUsageRuleOptions>();
    const [textRuleDraft, setTextRuleDraft] = useState({ cacheReadMissingAsZero: false, cacheWriteMissingAsZero: false, evidence: "" });
    const [textRuleBusy, setTextRuleBusy] = useState(false);
    const [textExceptions, setTextExceptions] = useState<TextPricingExceptions>();
    const [globalExceptions, setGlobalExceptions] = useState<TextPricingExceptions>();
    const [globalExceptionSummary, setGlobalExceptionSummary] = useState<TextPricingExceptions>();
    const [globalExceptionOpen, setGlobalExceptionOpen] = useState(false);
    const [globalExceptionModel, setGlobalExceptionModel] = useState("");
    const [globalExceptionChannel, setGlobalExceptionChannel] = useState("");
    const [globalExceptionStatus, setGlobalExceptionStatus] = useState<"pending-review" | "settled-warning" | undefined>();
    const exceptionRequestId = useRef(0);
    const [showTextExceptions, setShowTextExceptions] = useState(false);
    const [admissionBusy, setAdmissionBusy] = useState(false);
    const [directedTest, setDirectedTest] = useState<{ bindingKey: string; channelName: string; capability: DirectedPricingCapability } | null>(null);
    const [directedOperation, setDirectedOperation] = useState<"generation" | "edit">("generation");
    const [directedPrompt, setDirectedPrompt] = useState("");
    const [directedReference, setDirectedReference] = useState("");
    const [directedReferenceLabel, setDirectedReferenceLabel] = useState("");
    const [directedCreatedImages, setDirectedCreatedImages] = useState<string[]>([]);
    const directedCreatedImagesByBinding = useRef<Record<string, string[]>>({});
    const [directedMentionOpen, setDirectedMentionOpen] = useState(false);
    const [directedTask, setDirectedTask] = useState<{ id: string; status: string; error?: string; executionPhase?: string } | null>(null);
    const [directedEvidence, setDirectedEvidence] = useState<DirectedPricingEvidence>(null);
    const [directedBusy, setDirectedBusy] = useState(false);
    const [sampleSource, setSampleSource] = useState("");
    const [usage, setUsage] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<SalesPreview>();
    const [selectionOperation, setSelectionOperation] = useState<ModelPriceBinding["operation"]>("generation");
    const [selectionOptions, setSelectionOptions] = useState<IndependentOfficialPriceOptions>();
    const [selectionPage, setSelectionPage] = useState(1);
    const [selectionQuery, setSelectionQuery] = useState("");
    const [selectionSearch, setSelectionSearch] = useState("");
    const [selectionVersionId, setSelectionVersionId] = useState("");
    const [selectionBinding, setSelectionBinding] = useState<ModelPriceSelection | null>(null);
    const [selectionEvidence, setSelectionEvidence] = useState("");
    const [selectionBusy, setSelectionBusy] = useState(false);
    const [candidateOpen, setCandidateOpen] = useState(false);
    const [candidate, setCandidate] = useState<OfficialPriceDraft>(emptyCandidate);
    const [candidateOrigin, setCandidateOrigin] = useState<"manual" | "discovery" | "correction">("manual");
    const [correctionTarget, setCorrectionTarget] = useState<{ observation: OfficialPriceObservationPage["observations"][number]; variantIndex: number } | null>(null);
    const [correctionEvidence, setCorrectionEvidence] = useState<string[]>([]);
    const [correctionReason, setCorrectionReason] = useState("");
    const candidateInitial = useRef("");
    const candidateWasOpen = useRef(false);
    const [editingCandidate, setEditingCandidate] = useState<PriceCandidate | null>(null);
    const [references, setReferences] = useState<PriceReferences>({ series: [], versions: [], approved: [], pending: [] });
    const [structurePickerOpen, setStructurePickerOpen] = useState(false);
    const [structureReferences, setStructureReferences] = useState<OfficialPriceVersion[]>([]);
    const [structureLoading, setStructureLoading] = useState(false);
    const [catalogManufacturer, setCatalogManufacturer] = useState("");
    const [catalogEntries, setCatalogEntries] = useState<OfficialPriceCatalogEntry[]>([]);
    const [candidateCatalog, setCandidateCatalog] = useState<OfficialPriceCatalogEntry[]>([]);
    const [visiblePriceCatalog, setVisiblePriceCatalog] = useState<Record<string, OfficialPriceCatalogEntry[]>>({});
    const [catalogSelectedSeries, setCatalogSelectedSeries] = useState("");
    const [catalogCapability, setCatalogCapability] = useState("");
    const [catalogSearch, setCatalogSearch] = useState("");
    const [catalogDetail, setCatalogDetail] = useState<OfficialPriceCatalogEntry | null>(null);
    const [catalogImpact, setCatalogImpact] = useState<{ pending: number; approved: number; called: boolean; childVersions: number } | null>(null);
    const [catalogEditor, setCatalogEditor] = useState<"series" | "version" | null>(null);
    const [catalogEditingEntry, setCatalogEditingEntry] = useState<OfficialPriceCatalogEntry | null>(null);
    const [catalogEditorFromCandidate, setCatalogEditorFromCandidate] = useState(false);
    const [catalogDraft, setCatalogDraft] = useState({ manufacturer: "", parentId: "", name: "", capability: "text", sku: "", sourceUrl: "", evidence: "" });
    const [catalogBusy, setCatalogBusy] = useState(false);
    const [showLegacySeries, setShowLegacySeries] = useState(false);
    const [priceReferenceSource, setPriceReferenceSource] = useState("");
    const [priceReferenceReview, setPriceReferenceReview] = useState<boolean[] | null>(null);
    const [priceReferenceIdentity, setPriceReferenceIdentity] = useState("");
    const [conversionOpen, setConversionOpen] = useState(false);
    const [conversionDraft, setConversionDraft] = useState<BusinessExchangeRate>(emptyConversion);
    const [candidateFilter, setCandidateFilter] = useState<CandidateFilter>({ status: "pending" });
    const [unpricedFilter, setUnpricedFilter] = useState<UnpricedModelFilter>({});
    const [sourceOpen, setSourceOpen] = useState(false);
    const [sourceEditing, setSourceEditing] = useState<OfficialPriceSource | null>(null);
    const [sourceManufacturer, setSourceManufacturer] = useState("");
    const [sourceDraft, setSourceDraft] = useState("");
    const [audioContractPrice, setAudioContractPrice] = useState<OfficialPriceVersion | null>(null);
    const [videoContractPrice, setVideoContractPrice] = useState<OfficialPriceVersion | null>(null);
    const [imageContractPrice, setImageContractPrice] = useState<OfficialPriceVersion | null>(null);
    const [contractPrice, setContractPrice] = useState<OfficialPriceVersion | null>(null);
    const [pendingContract, setPendingContract] = useState<{ kind: "text" | "image" | "video" | "audio"; price: OfficialPriceVersion } | null>(null);
    const requestId = useRef(0);
    const [busy, setBusy] = useState(false);
    const [aiReviewOpen, setAiReviewOpen] = useState(false);
    const [aiDiscoveryOnly, setAiDiscoveryOnly] = useState(false);
    const [aiTargetOfficialModelId, setAiTargetOfficialModelId] = useState("");
    const [aiReviewBusy, setAiReviewBusy] = useState(false);
    const [aiReviewRunning, setAiReviewRunning] = useState(false);
    const [aiReviewElapsed, setAiReviewElapsed] = useState(0);
    const [aiReviewProgress, setAiReviewProgress] = useState<Partial<Record<PriceReviewProgress["stage"], ReviewUiProgress>>>({});
    const [aiReviewError, setAiReviewError] = useState("");
    const [aiReviewResult, setAiReviewResult] = useState<PriceReviewResult>();
    const [aiManufacturer, setAiManufacturer] = useState("");
    const [aiSourceUrl, setAiSourceUrl] = useState("");
    const [aiSourceLinks, setAiSourceLinks] = useState<Array<{ url: string; label: string }>>([]);
    const [aiSourceBusy, setAiSourceBusy] = useState(false);
    const [officialExcerpt, setOfficialExcerpt] = useState("");
    const [retirementExcerpt, setRetirementExcerpt] = useState("");
    const [savedFindingKeys, setSavedFindingKeys] = useState<string[]>([]);
    const [observationPage, setObservationPage] = useState<OfficialPriceObservationPage>();
    const [confirmedObservationPage, setConfirmedObservationPage] = useState<OfficialPriceObservationPage>();
    const [observationManufacturer, setObservationManufacturer] = useState("");
    const [invalidationTarget, setInvalidationTarget] = useState<OfficialPriceObservationPage["observations"][number] | null>(null);
    const [invalidationReason, setInvalidationReason] = useState("");
    const bytePlusReview = aiManufacturer === "ByteDance / Volcengine" && /^https:\/\/docs\.byteplus\.com\//i.test(aiSourceUrl);

    useEffect(() => {
        if (candidateOpen && !candidateWasOpen.current) candidateInitial.current = JSON.stringify({ candidate, correctionEvidence, correctionReason });
        candidateWasOpen.current = candidateOpen;
    }, [candidateOpen, candidate, correctionEvidence, correctionReason]);

    useEffect(() => {
        if (!aiReviewRunning) return;
        const startedAt = Date.now();
        const interval = setInterval(() => setAiReviewElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => clearInterval(interval);
    }, [aiReviewRunning]);

    useEffect(() => {
        let alive = true;
        const id = ++requestId.current;
        const savedManufacturer = window.localStorage.getItem(`admin-pricing-manufacturer:${currentUser.id}`) || undefined;
        const initialFilter: ModelWorkbenchFilter = { enabled: "active", manufacturer: savedManufacturer };
        setWorkbenchFilter(initialFilter);
        void getModelPricing(undefined, 1, 1, { status: "pending" }, 1, {}, 1, initialFilter)
            .then((data) => {
                if (!alive || id !== requestId.current) return;
                setOverview(data);
                const current = data.salesVersions.at(-1);
                if (current)
                    setPolicy({
                        priceVersionIds: current.priceVersionIds,
                        selectedPriceBindings: current.selectedPriceBindings || [],
                        userPriceRules: current.userPriceRules || [],
                        conversion: current.conversion,
                        usdPerCurrency: current.usdPerCurrency || {},
                        pointsPerCurrency: current.pointsPerCurrency,
                        rateEvidence: current.rateEvidence,
                        deepSeekUtcWindowModels: current.deepSeekUtcWindowModels || [],
                    });
                else if (data.exchangeRate) setPolicy({ ...emptyPolicy(), conversion: { ...data.exchangeRate, pointsPerCny: POINTS_PER_CNY } });
                setModelId(data.selectedModelId);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "模型售价加载失败"));
        return () => {
            alive = false;
        };
    }, [message, currentUser.id]);

    useEffect(() => {
        if (!canReview) return;
        let alive = true;
        void getOfficialPriceObservations(1, "", "pending")
            .then((data) => {
                if (alive) setObservationPage(data);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "官网发现加载失败");
            });
        return () => {
            alive = false;
        };
    }, [canReview, message]);

    useEffect(() => {
        if (!canReview || activeGroup !== "official" || officialSub !== "pending") return;
        void getOfficialPriceObservations(1, candidateFilter.manufacturer || "", "confirmed")
            .then(setConfirmedObservationPage)
            .catch((error) => message.error(error instanceof Error ? error.message : "待关联型号加载失败"));
    }, [canReview, activeGroup, officialSub, candidateFilter.manufacturer, message]);

    useEffect(() => {
        if (!canPublish) return;
        let alive = true;
        void getTextPricingExceptions()
            .then((result) => {
                if (alive) setGlobalExceptionSummary(result);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "计费异常加载失败");
            });
        return () => {
            alive = false;
        };
    }, [canPublish, message]);

    useEffect(() => {
        if (!candidateOpen || !candidate.manufacturer) return;
        let alive = true;
        void getOfficialPriceReferences(candidate.manufacturer, candidate.series, candidate.officialVersion)
            .then((data) => {
                if (alive) setReferences(data);
            })
            .catch((error) => {
                if (alive) showError(error);
            });
        return () => {
            alive = false;
        };
    }, [candidateOpen, candidate.manufacturer, candidate.series, candidate.officialVersion]);

    useEffect(() => {
        if (!candidateOpen || !structurePickerOpen || (!candidate.logicalModelId && (!candidate.manufacturer || !candidate.capability))) return;
        let alive = true;
        setStructureReferences([]);
        setStructureLoading(true);
        void getOfficialPriceStructureReferences(candidate.logicalModelId, candidate.manufacturer, candidate.capability)
            .then((data) => {
                if (alive) setStructureReferences(data);
            })
            .catch((error) => {
                if (alive) showError(error);
            })
            .finally(() => {
                if (alive) setStructureLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [candidateOpen, structurePickerOpen, candidate.logicalModelId, candidate.manufacturer, candidate.capability]);

    useEffect(() => {
        if (!candidateOpen || !candidate.manufacturer || !canReview) return;
        let alive = true;
        void getOfficialPriceCatalog(candidate.manufacturer)
            .then((entries) => {
                if (alive) setCandidateCatalog(entries);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "目录加载失败");
            });
        return () => {
            alive = false;
        };
    }, [candidateOpen, candidate.manufacturer, canReview, message]);

    useEffect(() => {
        if (activeGroup !== "official" || officialSub !== "catalog" || !canReview) return;
        const manufacturer = catalogManufacturer || overview?.officialSources[0]?.manufacturer;
        if (!manufacturer) return;
        let alive = true;
        void getOfficialPriceCatalog(manufacturer)
            .then((entries) => {
                if (alive) setCatalogEntries(entries);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "目录加载失败");
            });
        return () => {
            alive = false;
        };
    }, [activeGroup, officialSub, catalogManufacturer, overview?.officialSources, canReview, message]);

    useEffect(() => {
        if (!overview || (activeGroup !== "workbench" && (activeGroup !== "official" || (officialSub !== "pending" && officialSub !== "approved")))) return;
        const manufacturers = [...new Set([...overview.candidates, ...overview.approvedVersions, ...overview.officialVersions, ...overview.boundVersions].map((item) => item.manufacturer))];
        let alive = true;
        void Promise.all(manufacturers.map(async (manufacturer) => [manufacturer, await getOfficialPriceCatalog(manufacturer)] as const))
            .then((groups) => {
                if (alive) setVisiblePriceCatalog(Object.fromEntries(groups));
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "目录名称加载失败");
            });
        return () => {
            alive = false;
        };
    }, [activeGroup, officialSub, overview?.candidates, overview?.approvedVersions, overview?.officialVersions, overview?.boundVersions, message]);

    useEffect(() => {
        if (!catalogDetail) {
            setCatalogImpact(null);
            return;
        }
        let alive = true;
        void getOfficialPriceCatalogImpact(catalogDetail)
            .then((impact) => {
                if (alive) setCatalogImpact(impact);
            })
            .catch((error) => {
                if (alive) message.error(error instanceof Error ? error.message : "目录引用状态加载失败");
            });
        return () => {
            alive = false;
        };
    }, [catalogDetail, message]);

    useEffect(() => {
        if (!priceReferenceReview || !priceReferenceSource) return;
        if (!candidate.items.length) {
            setPriceReferenceReview(null);
            setPriceReferenceSource("");
            return;
        }
        const identity = priceReferenceIdentityOf(candidate);
        if (identity !== priceReferenceIdentity) {
            setPriceReferenceReview(candidate.items.map(() => false));
            setPriceReferenceIdentity(identity);
        }
    }, [candidate, priceReferenceIdentity, priceReferenceReview, priceReferenceSource]);

    useEffect(() => {
        if (!aiReviewOpen || !aiManufacturer) return;
        let alive = true;
        setAiSourceBusy(true);
        void getOfficialPriceReviewLinks(aiManufacturer)
            .then((links) => {
                if (alive) {
                    setAiSourceLinks(links);
                    setAiSourceUrl((current) => (links.some((link) => link.url === current) ? current : links[0]?.url || ""));
                }
            })
            .catch((error) => {
                if (alive) showError(error);
            })
            .finally(() => {
                if (alive) setAiSourceBusy(false);
            });
        return () => {
            alive = false;
        };
    }, [aiReviewOpen, aiManufacturer]);

    const modelVersions = useMemo(() => {
        const versions = [...(overview?.officialVersions || []), ...(overview?.boundVersions || [])].filter((item) => item.logicalModelId === modelId);
        return versions.filter((item, index) => versions.findIndex((other) => other.id === item.id) === index);
    }, [overview, modelId]);
    const selectedPrice = modelVersions.find((item) => item.id === policy.priceVersionIds[modelId]);
    const publishedPolicy = overview?.salesVersions.at(-1);
    const modelCapability = overview?.models.find((item) => item.id === modelId)?.capability;
    const priceContractKind = modelCapability === "text" || modelCapability === "image" || modelCapability === "video" || modelCapability === "audio" ? modelCapability : null;
    const modelManufacturer = overview?.models.find((item) => item.id === modelId)?.manufacturer;
    const selectionOperations: ModelPriceBinding["operation"][] = modelCapability === "image" ? ["generations", "edits"] : modelCapability === "audio" ? ["generateContent", "chat/completions"] : ["generation"];
    const selectionScope = modelCapability && selectionOperations.includes(selectionOperation) ? `${modelCapability}:${selectionOperation}:standard` : "";
    const selectedReference = policy.selectedPriceBindings?.find((item) => item.logicalModelId === modelId && item.scope === selectionScope);
    const publishedSelections = publishedPolicy?.selectedPriceBindings?.filter((item) => item.logicalModelId === modelId) || [];
    const activationImageOperation = modelCapability === "image" && !publishedPolicy?.priceVersionIds[modelId] && (selectionOperation === "generations" || selectionOperation === "edits") ? selectionOperation : undefined;
    const activationAudioOperation = modelCapability === "audio" && !publishedPolicy?.priceVersionIds[modelId] && (selectionOperation === "generateContent" || selectionOperation === "chat/completions") ? selectionOperation : undefined;
    const independentPrice = [...(selectionOptions?.items.map((item) => item.version) || []), ...(overview?.boundVersions || []), ...(selectionBinding?.version ? [selectionBinding.version] : [])].find(
        (item) => item.id === (selectedReference?.officialVersionId || selectionVersionId || selectionBinding?.officialVersionId),
    );
    useEffect(() => {
        setSelectionOperation(modelCapability === "image" ? "generations" : modelCapability === "audio" ? "generateContent" : "generation");
        setSelectionPage(1);
        setSelectionSearch("");
        setSelectionQuery("");
        setSelectionOptions(undefined);
        setSelectionBinding(null);
        setSelectionVersionId("");
        setSelectionEvidence("");
    }, [modelId, modelCapability]);
    useEffect(() => {
        if (!modelDrawerOpen || !modelId || !(canReview || canPublish)) return;
        if (!modelManufacturer) {
            setSelectionOptions(undefined);
            return;
        }
        let active = true;
        void getIndependentOfficialPriceOptions(modelId, selectionPage, selectionSearch)
            .then((options) => {
                if (active) setSelectionOptions(options);
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "独立官网价加载失败");
            });
        return () => {
            active = false;
        };
    }, [modelDrawerOpen, modelId, modelManufacturer, canReview, canPublish, selectionPage, selectionSearch, message]);
    useEffect(() => {
        if (!modelDrawerOpen || !modelId || !selectionScope || !(canReview || canPublish)) return;
        let active = true;
        void getCurrentModelPriceSelection(modelId, selectionScope)
            .then((binding) => {
                if (!active) return;
                setSelectionBinding(binding);
                setSelectionVersionId(binding?.officialVersionId || "");
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "当前选价绑定加载失败");
            });
        return () => {
            active = false;
        };
    }, [modelDrawerOpen, modelId, selectionScope, canReview, canPublish, message]);
    const salePrice = selectedPrice || (selectedReference ? independentPrice : undefined);
    const salePriceId = salePrice?.id;
    const publishedTextVersionId = publishedPolicy?.priceVersionIds[modelId] || publishedSelections.find((item) => item.scope === "text:generation:standard")?.officialVersionId;
    useEffect(() => {
        if (!modelId || !salePriceId || publishedTextVersionId !== salePriceId || activationStatus?.admission.capability !== "text") {
            setTextRuleOptions(undefined);
            setTextExceptions(undefined);
            return;
        }
        let active = true;
        void getTextUsageRuleOptions(modelId)
            .then((options) => {
                if (!active) return;
                const current = options.rules[0];
                setTextRuleOptions(options);
                setTextRuleDraft({ cacheReadMissingAsZero: current?.cacheReadMissingAsZero || false, cacheWriteMissingAsZero: current?.cacheWriteMissingAsZero || false, evidence: current?.evidence || "" });
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "文本用量规则加载失败");
            });
        void getTextPricingExceptions(modelId)
            .then((result) => {
                if (active) setTextExceptions(result);
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "文本计费异常加载失败");
            });
        return () => {
            active = false;
        };
    }, [modelId, salePriceId, publishedTextVersionId, activationStatus?.admission.capability, message]);
    const draftSaleChanged = Boolean(
        !publishedPolicy ||
        JSON.stringify(policy.selectedPriceBindings?.filter((item) => item.logicalModelId === modelId) || []) !== JSON.stringify(publishedSelections) ||
        (selectedReference && !independentPrice) ||
        (salePrice &&
            ((selectedPrice && publishedPolicy?.priceVersionIds[modelId] !== selectedPrice.id) ||
                resolveUserPriceCoefficient(salePrice, policy, modelId).value !== resolveUserPriceCoefficient(salePrice, publishedPolicy, modelId).value ||
                (supportsDeepSeekTimePricing(salePrice) && Boolean(policy.deepSeekUtcWindowModels?.includes(modelId)) !== Boolean(publishedPolicy?.deepSeekUtcWindowModels?.includes(modelId))) ||
                policy.conversion?.cnyPerUsd !== publishedPolicy.conversion?.cnyPerUsd ||
                salePrice.items.some((item) => policy.usdPerCurrency[item.currency] !== publishedPolicy.usdPerCurrency[item.currency]))),
    );
    const needsContractReview = !activationStatus?.admission.officialVersionId || (activationStatus.admission.modelId === modelId && activationStatus.admission.blockers.some((reason) => reason.includes("契约")));
    const currencies = useMemo(
        () =>
            Array.from(
                new Set(
                    [...(overview?.officialVersions || []), ...(overview?.boundVersions || []), ...(selectionOptions?.items.map((item) => item.version) || [])]
                        .filter((item) => [...Object.values(policy.priceVersionIds), ...(policy.selectedPriceBindings?.map((ref) => ref.officialVersionId) || [])].includes(item.id))
                        .flatMap((item) => (item.textPriceSchedule ? item.textPriceSchedule.groups.flatMap((group) => group.lines.map((line) => line.currency)) : item.items.map((line) => line.currency))),
                ),
            ).sort(),
        [overview, policy.priceVersionIds, policy.selectedPriceBindings, selectionOptions],
    );
    const updatePolicy = (next: SalesPolicy) => {
        setPolicy(next);
        setPreview(undefined);
    };
    const applyActivationStatus = (status: ModelPricingActivationStatus) => {
        setActivationStatus(status);
        const sample = status.admission.officialVersionId === selectedPrice?.id ? status.shadow?.sample : null;
        if (sample) {
            setUsage((current) => (Object.keys(current).length ? current : sample.usage));
            setSampleSource(`最近真实调用：${sample.observedAt} · 渠道 ${sample.channelId}${sample.complete ? "" : "；只填入上游明确返回的分项，其他用量需人工确认"}`);
        } else setSampleSource("");
    };
    useEffect(() => {
        if (!modelId) return;
        let alive = true;
        setActivationStatus(undefined);
        void Promise.all([getModelPricingActivationStatus(modelId, activationImageOperation, activationAudioOperation), selectedPrice ? getModelPricingSampleUsage(modelId, selectedPrice.id) : Promise.resolve(null)])
            .then(([status, fallbackSample]) => {
                if (!alive) return;
                applyActivationStatus(status);
                if (!status.shadow?.sample && fallbackSample) {
                    setUsage((current) => (Object.keys(current).length ? current : fallbackSample.usage));
                    setSampleSource(`最近真实调用：${fallbackSample.observedAt} · 渠道 ${fallbackSample.channelId}${fallbackSample.complete ? "" : "；只填入上游明确返回的分项，其他用量需人工确认"}`);
                }
            })
            .catch((error) => {
                if (alive) showError(error);
            });
        return () => {
            alive = false;
        };
    }, [modelId, selectedPrice?.id, overview?.currentSalesVersionId, activationImageOperation, activationAudioOperation]);
    const loadOverview = async (
        selectedModelId: string,
        candidatePage: number,
        officialPage: number,
        filter: CandidateFilter,
        unpricedPage = overview?.unpricedPage || 1,
        modelsFilter = unpricedFilter,
        workbenchPage = overview?.workbenchPage || 1,
        workbenchFilters = workbenchFilter,
    ) => {
        const id = ++requestId.current;
        const data = await getModelPricing(selectedModelId, candidatePage, officialPage, filter, unpricedPage, modelsFilter, workbenchPage, workbenchFilters);
        if (id === requestId.current) setOverview(data);
        return data;
    };
    const refresh = (candidatePage = overview?.candidatePage || 1, officialPage = overview?.officialPage || 1) => loadOverview(modelId, candidatePage, officialPage, candidateFilter);
    const changeCandidateFilter = (filter: CandidateFilter) => {
        if (filter.manufacturer !== candidateFilter.manufacturer) setOverview((current) => (current ? { ...current, candidateModelIds: [] } : current));
        setCandidateFilter(filter);
        void loadOverview(modelId, 1, overview?.officialPage || 1, filter).catch(showError);
    };
    const changeWorkbenchFilter = (filter: ModelWorkbenchFilter) => {
        if (filter.manufacturer !== workbenchFilter.manufacturer) {
            if (filter.manufacturer) window.localStorage.setItem(`admin-pricing-manufacturer:${currentUser.id}`, filter.manufacturer);
            else window.localStorage.removeItem(`admin-pricing-manufacturer:${currentUser.id}`);
        }
        setWorkbenchFilter(filter);
        void loadOverview(modelId, overview?.candidatePage || 1, overview?.officialPage || 1, candidateFilter, overview?.unpricedPage || 1, unpricedFilter, 1, filter).catch(showError);
    };
    const openModel = (selectedModelId: string) => {
        setModelId(selectedModelId);
        setUsage({});
        setPreview(undefined);
        setModelDrawerOpen(true);
        setModelDetailView("overview");
        void loadOverview(selectedModelId, overview?.candidatePage || 1, 1, candidateFilter).catch(showError);
    };
    const showError = (error: unknown) => message.error(error instanceof Error ? error.message : "操作失败");
    const closeCandidate = () => {
        const discard = () => {
            setCandidateOpen(false);
            setStructurePickerOpen(false);
            setEditingCandidate(null);
        };
        if (JSON.stringify({ candidate, correctionEvidence, correctionReason }) === candidateInitial.current) {
            discard();
            return;
        }
        modal.confirm({ title: "放弃未保存的价目草稿？", content: "当前修改尚未保存，关闭后会丢失。", okText: "放弃并关闭", okButtonProps: { danger: true }, cancelText: "继续编辑", onOk: discard });
    };
    const loadGlobalExceptions = (selectedModel = globalExceptionModel, selectedChannel = globalExceptionChannel, selectedStatus = globalExceptionStatus, offset = 0) => {
        const id = ++exceptionRequestId.current;
        void getTextPricingExceptions(selectedModel, offset, { channelId: selectedChannel, status: selectedStatus })
            .then((result) => {
                if (id === exceptionRequestId.current) setGlobalExceptions(result);
            })
            .catch(showError);
    };
    const saveActivation = async (enabled: boolean, bindingKey?: string) => {
        if (!activationStatus) return;
        setAdmissionBusy(true);
        try {
            const result = await setModelPricingActivation({
                modelId: activationStatus.admission.modelId,
                enabled,
                expectedRevision: activationStatus.activation?.revision || null,
                bindingKey,
                imageOperation: activationImageOperation,
                audioOperation: activationAudioOperation,
            });
            setActivationStatus(result);
            message.success(result.active ? (bindingKey ? "该渠道已纳入按量路由" : "已启用该模型按量计费") : "该模型使用固定积分计费");
        } catch (error) {
            showError(error);
        } finally {
            setAdmissionBusy(false);
        }
    };
    const saveTextRule = async () => {
        if (!textRuleOptions || !salePrice) return;
        setTextRuleBusy(true);
        try {
            await reviewTextUsageRule({ modelId, officialVersionId: salePrice.id, ...textRuleDraft, expectedCurrentId: textRuleOptions.rules[0]?.id || null });
            const options = await getTextUsageRuleOptions(modelId);
            setTextRuleOptions(options);
            applyActivationStatus(await getModelPricingActivationStatus(modelId));
            message.success("文本用量规则已审核；现有按量路由仍使用原规则，切换需核对影子报价");
        } catch (error) {
            showError(error);
        } finally {
            setTextRuleBusy(false);
        }
    };
    const reloadActivationStatus = (selectedModelId = modelId) => void getModelPricingActivationStatus(selectedModelId, activationImageOperation, activationAudioOperation).then(applyActivationStatus).catch(showError);
    const revalueImageEvidence = async (bindingKey: string) => {
        setAdmissionBusy(true);
        try {
            const result = await revalueSavedImageEvidence(modelId, bindingKey, activationImageOperation);
            setActivationStatus(await getModelPricingActivationStatus(modelId, activationImageOperation, activationAudioOperation));
            message.info(result.revalued ? `已复核 ${result.revalued} 份历史真实用量，请核对影子报价` : "没有可复用的历史影子报价，请检查缺少的操作证据");
        } catch (error) {
            showError(error);
        } finally {
            setAdmissionBusy(false);
        }
    };
    const revalueTextEvidence = async (bindingKey: string) => {
        setAdmissionBusy(true);
        try {
            const result = await revalueSavedTextEvidence(modelId, bindingKey);
            applyActivationStatus(await getModelPricingActivationStatus(modelId));
            message.info(result.revalued ? `已按当前规则复核 ${result.revalued} 份已有真实响应` : "没有符合当前规则的已有响应，请执行定向验收");
        } catch (error) {
            showError(error);
        } finally {
            setAdmissionBusy(false);
        }
    };
    const runDirectedTest = async () => {
        if (!directedTest || !directedPrompt.trim()) return;
        setDirectedBusy(true);
        try {
            const task = await createDirectedPricingTask({ ...directedTest, modelId, operation: directedOperation, prompt: directedPrompt.trim(), referenceDataUrl: directedReference || undefined });
            if (directedTest.capability === "image" && directedOperation === "generation") {
                setDirectedCreatedImages([]);
                delete directedCreatedImagesByBinding.current[`${modelId}/${directedTest.bindingKey}`];
            }
            setDirectedTask(task);
            setDirectedEvidence(null);
            message.success("定向任务已提交；完成后读取任务结果并刷新计费状态");
        } catch (error) {
            showError(error);
        } finally {
            setDirectedBusy(false);
        }
    };
    const refreshDirectedTask = async () => {
        if (!directedTask || !directedTest) return;
        setDirectedBusy(true);
        try {
            const task = await getDirectedPricingTask(directedTest.capability, directedTask.id);
            setDirectedTask(task);
            setDirectedEvidence(await getDirectedPricingEvidence(directedTest.capability, task.id));
            if (directedTest.capability === "image" && directedOperation === "generation" && task.status === "success" && task.result) {
                const results = task.result.results?.length ? task.result.results : [task.result];
                const images = results.map((result) => result.serverUrl || result.dataUrl).filter(Boolean);
                setDirectedCreatedImages(images);
                directedCreatedImagesByBinding.current[`${modelId}/${directedTest.bindingKey}`] = images;
            }
            if (task.status === "success") reloadActivationStatus();
        } catch (error) {
            showError(error);
        } finally {
            setDirectedBusy(false);
        }
    };
    const saveSourceLink = async () => {
        setBusy(true);
        try {
            const source = await saveOfficialPriceSourceLink(sourceEditing?.manufacturer || sourceManufacturer.trim(), sourceDraft.trim(), sourceEditing?.updatedAt || null, !sourceEditing);
            setOverview((current) => (current ? { ...current, officialSources: [...current.officialSources.filter((item) => item.manufacturer !== source.manufacturer), source].sort((a, b) => a.manufacturer.localeCompare(b.manufacturer)) } : current));
            setSourceEditing(null);
            setSourceOpen(false);
            message.success("厂商官网价格链接已保存；历史价目证据不变");
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    };
    const saveConversion = async () => {
        setBusy(true);
        try {
            const cnyPerUsd = new Decimal(conversionDraft.cnyPerUsd.trim());
            if (!cnyPerUsd.isFinite() || !cnyPerUsd.isPositive() || !conversionDraft.evidence.trim()) throw new Error("请填写正数汇率和汇率依据");
            const exchangeRate = await saveModelExchangeRate({ cnyPerUsd: cnyPerUsd.toFixed(), evidence: conversionDraft.evidence.trim(), observedAt: new Date().toISOString() }, overview?.exchangeRate?.observedAt || null);
            setOverview((current) => (current ? { ...current, exchangeRate } : current));
            const conversion = { ...exchangeRate, pointsPerCny: POINTS_PER_CNY };
            updatePolicy({
                ...policy,
                conversion,
                pointsPerCurrency: { ...policy.pointsPerCurrency, CNY: POINTS_PER_CNY, USD: cnyPerUsd.mul(POINTS_PER_CNY).toFixed() },
                rateEvidence: { ...policy.rateEvidence, CNY: conversion.evidence, USD: conversion.evidence },
            });
            setConversionOpen(false);
            message.success("汇率已保存并应用到售价草稿");
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    };

    const submitCandidate = async () => {
        if (priceReferenceReview?.some((reviewed) => !reviewed)) {
            message.error("请逐项核对带入的参考价格与目标型号官网价目");
            return;
        }
        const issues = officialPriceDraftIssues(candidate);
        if (issues.length) {
            message.error(`请先核对：${issues.join("、")}`);
            return;
        }
        setBusy(true);
        try {
            const verified = candidate as OfficialPriceInput;
            if (editingCandidate) await editOfficialPrice(editingCandidate.id, verified, editingCandidate.revision || null);
            else await submitOfficialPrice(verified);
            await refresh(1);
            setCandidateOpen(false);
            setCandidate(emptyCandidate());
            setPriceReferenceReview(null);
            setPriceReferenceSource("");
            setEditingCandidate(null);
            message.success(editingCandidate ? "已修订原候选并重新提交审核" : "已提交待审核价目");
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    };

    const runAiReview = async () => {
        if (!aiManufacturer || !aiSourceUrl) {
            message.error("请先选择厂商和官网价格链接");
            return;
        }
        setAiReviewBusy(true);
        setAiReviewRunning(true);
        setAiReviewElapsed(0);
        setAiReviewProgress({});
        setAiReviewError("");
        setAiReviewResult(undefined);
        setSavedFindingKeys([]);
        try {
            const result = await reviewOfficialPrices(
                {
                    manufacturer: aiManufacturer,
                    sourceUrl: aiSourceUrl,
                    requestId: crypto.randomUUID(),
                    discoveryOnly: aiDiscoveryOnly,
                    ...(aiTargetOfficialModelId ? { targetOfficialModelId: aiTargetOfficialModelId } : {}),
                    ...(officialExcerpt.trim() ? { sourceText: officialExcerpt.trim() } : {}),
                    ...(bytePlusReview && retirementExcerpt.trim() ? { retirementText: retirementExcerpt.trim() } : {}),
                },
                (progress) => setAiReviewProgress((current) => ({ ...current, [progress.stage]: progress })),
                setAiReviewResult,
            );
            setAiReviewResult(result);
            if (aiDiscoveryOnly) {
                const saved: string[] = [];
                const failed: string[] = [];
                const grouped = new Map<string, PriceReviewResult["findings"]>();
                for (const finding of result.findings) {
                    const key = finding.officialModelId.toLowerCase();
                    grouped.set(key, [...(grouped.get(key) || []), finding]);
                }
                for (const finding of result.findings) {
                    const variants = grouped.get(finding.officialModelId.toLowerCase());
                    if (!variants) continue;
                    grouped.delete(finding.officialModelId.toLowerCase());
                    try {
                        await saveOfficialPriceObservation(result, finding, true, variants);
                        saved.push(`${finding.officialModelId}:${finding.evidence}`);
                    } catch {
                        failed.push(finding.officialModelId);
                    }
                }
                setSavedFindingKeys(saved);
                await loadObservations(1);
                const summary = `识别 ${result.sourceOfficialModelIds.length + (result.skippedExistingModelIds?.length || 0) + (result.uncertainModelIds?.length || 0)} 个，跳过已有 ${result.skippedExistingModelIds?.length || 0} 个，新增归档 ${saved.length} 个，待核对 ${result.missingOfficialModelIds.length + (result.uncertainModelIds?.length || 0)} 个`;
                if (failed.length) message.warning(`${summary}；保存失败：${failed.join("、")}`);
                else message.success(summary);
            } else if (result.missingOfficialModelIds.length) message.warning(`官网识别 ${result.sourceOfficialModelIds.length} 个本厂商型号，${result.missingOfficialModelIds.length} 个尚未完成核对`);
            else message.success(`已核对 ${result.findings.length} 个官网价目或生命周期项`);
        } catch (error) {
            const detail = error instanceof Error ? error.message : "官网价目核对失败";
            setAiReviewError(detail);
            setAiReviewProgress((current) => {
                const active = [...reviewStages].reverse().find((stage) => current[stage.id]?.status === "active");
                return active ? { ...current, [active.id]: { stage: active.id, status: "failed", detail } } : current;
            });
            showError(error);
        } finally {
            setAiReviewBusy(false);
            setAiReviewRunning(false);
        }
    };

    const openAiPriceDraft = (finding: PriceReviewResult["findings"][number]) => {
        if (!aiReviewResult || !finding.observedItems.length) return;
        setPriceReferenceReview(null);
        setPriceReferenceSource("");
        setEditingCandidate(null);
        setCandidateOrigin("discovery");
        setCandidate({
            ...emptyCandidate(),
            logicalModelId: "",
            capability: overview?.models.find((model) => model.id === finding.logicalModelId)?.capability as OfficialPriceInput["capability"],
            manufacturer: aiReviewResult.manufacturer,
            series: finding.suggestedSeries || "",
            officialVersion: finding.suggestedVersion || "",
            sku: finding.officialModelId,
            tier: "",
            effectiveFrom: finding.suggestedEffectiveFrom,
            effectiveTo: finding.suggestedEffectiveTo,
            conditions: finding.observedConditions,
            sourceUrl: aiReviewResult.sourceUrl,
            evidence: [finding.evidence, finding.headerEvidence, `正文 SHA-256 ${aiReviewResult.sourceDigest}`].filter(Boolean).join("；"),
            observedAt: aiReviewResult.observedAt,
            items: finding.observedItems.map((item) => ({ ...item })),
        });
        setCandidateOpen(true);
    };

    const openObservationDraft = (item: OfficialPriceObservationPage["observations"][number], variant?: ReturnType<typeof officialPriceObservationVariants>[number]) => {
        setPriceReferenceReview(null);
        setPriceReferenceSource("");
        setEditingCandidate(null);
        setCandidateOrigin("discovery");
        setCandidate({
            ...emptyCandidate(),
            manufacturer: item.manufacturer,
            series: variant?.suggestedSeries || item.suggestedSeries || "",
            officialVersion: variant?.suggestedVersion || item.suggestedVersion || "",
            sku: item.officialModelId,
            tier: "",
            conditions: variant?.conditions ?? item.conditions,
            effectiveFrom: variant?.suggestedEffectiveFrom || item.suggestedEffectiveFrom,
            effectiveTo: variant?.suggestedEffectiveTo || item.suggestedEffectiveTo,
            sourceUrl: item.sourceUrl,
            evidence: [
                variant?.evidence || item.evidence,
                variant?.headerEvidence || item.headerEvidence,
                variant?.amendment ? `人工修订第 ${variant.amendment.revision} 版：${variant.amendment.reason}；分项原文：${variant.amendment.itemEvidence.join(" | ")}` : "",
                `正文 SHA-256 ${item.sourceDigest}`,
            ]
                .filter(Boolean)
                .join("；"),
            observedAt: item.observedAt,
            items: (variant?.items || item.items).map((price) => ({ ...price })),
        });
        setCandidateOpen(true);
    };

    const openObservationCorrection = (item: OfficialPriceObservationPage["observations"][number], variantIndex: number) => {
        const variant = officialPriceObservationVariants(item)[variantIndex];
        const original = item.priceVariants?.[variantIndex] || { evidence: item.evidence };
        if (!variant) return;
        setPriceReferenceReview(null);
        setPriceReferenceSource("");
        setEditingCandidate(null);
        setCandidateOrigin("correction");
        setCorrectionTarget({ observation: item, variantIndex });
        setCorrectionEvidence(variant.amendment?.itemEvidence || variant.items.map(() => original.evidence));
        setCorrectionReason("");
        setCandidate({
            ...emptyCandidate(),
            manufacturer: item.manufacturer,
            sku: item.officialModelId,
            sourceUrl: item.sourceUrl,
            evidence: original.evidence,
            observedAt: item.observedAt,
            conditions: variant.conditions,
            items: variant.items.map((price) => ({ ...price })),
        });
        setCandidateOpen(true);
    };

    const saveObservationCorrection = async () => {
        if (!correctionTarget) return;
        setBusy(true);
        try {
            await amendOfficialPriceObservation(correctionTarget.observation.id, {
                variantIndex: correctionTarget.variantIndex,
                items: candidate.items,
                itemEvidence: correctionEvidence,
                conditions: candidate.conditions,
                reason: correctionReason,
                expectedRevision: correctionTarget.observation.amendments?.length || 0,
            });
            await loadObservations();
            setCandidateOpen(false);
            setPriceReferenceReview(null);
            setPriceReferenceSource("");
            setCorrectionTarget(null);
            message.success("提取分项修订已保存，仍需确认证据");
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    };

    const loadObservations = async (page = observationPage?.page || 1, manufacturer = observationManufacturer) => {
        setObservationPage(await getOfficialPriceObservations(page, manufacturer, "pending"));
    };
    const loadConfirmedObservations = async (page = confirmedObservationPage?.page || 1) => {
        setConfirmedObservationPage(await getOfficialPriceObservations(page, candidateFilter.manufacturer || "", "confirmed"));
    };
    const archiveFinding = async (finding: PriceReviewResult["findings"][number]) => {
        if (!aiReviewResult) return;
        setAiReviewBusy(true);
        try {
            await saveOfficialPriceObservation(aiReviewResult, finding, aiDiscoveryOnly);
            setSavedFindingKeys((current) => [...current, `${finding.officialModelId}:${finding.evidence}`]);
            await loadObservations(1);
            message.success("官网发现已归档，待管理员核实");
        } catch (error) {
            showError(error);
        } finally {
            setAiReviewBusy(false);
        }
    };
    const reviewObservation = (id: string) =>
        modal.confirm({
            title: "确认这条官网证据？",
            content: "确认后移入待审价目；厂商、能力或价格不完整时，需先补齐。不会自动发布售价。",
            onOk: async () => {
                const manufacturer = observationPage?.observations.find((item) => item.id === id)?.manufacturer || "";
                const expectedRevision = observationPage?.observations.find((item) => item.id === id)?.amendments?.length || 0;
                await reviewOfficialPriceObservation(id, "confirmed", "", expectedRevision);
                await loadObservations();
                if (manufacturer !== candidateFilter.manufacturer || candidateFilter.status !== "pending") changeCandidateFilter({ ...candidateFilter, manufacturer, modelId: undefined, status: "pending" });
                else await loadConfirmedObservations(1);
                setOfficialSub("pending");
                message.success("证据已确认，已转入待审价目");
            },
        });
    const deleteObservation = (id: string) =>
        modal.confirm({
            title: "删除这条待确认发现？",
            content: "删除后将不再显示此档案；以后扫描官网仍可重新发现该型号。",
            okText: "删除发现",
            okButtonProps: { danger: true },
            onOk: async () => {
                await deleteOfficialPriceObservation(id);
                await loadObservations(1);
                message.success("发现档案已删除");
            },
        });
    const invalidateObservation = async () => {
        if (!invalidationTarget) return;
        try {
            await invalidateOfficialPriceObservation(invalidationTarget.id, invalidationReason);
            await loadConfirmedObservations();
            setInvalidationTarget(null);
            setInvalidationReason("");
            message.success("已撤销证据确认并解除模型关联");
        } catch (error) {
            showError(error);
        }
    };

    const setRetired = async (finding: PriceReviewResult["findings"][number], action: "mark" | "unmark") => {
        if (!finding.logicalModelId || !aiReviewResult) return;
        setAiReviewBusy(true);
        try {
            await setByteDanceSeedRetired({
                action,
                logicalModelId: finding.logicalModelId,
                officialModelId: finding.officialModelId,
                evidence: finding.evidence,
                evidenceMode: aiReviewResult.retirementMode === "admin-excerpt" ? "admin-excerpt" : "website",
                deactivationDate: finding.deactivationDate || undefined,
                observedAt: aiReviewResult.observedAt,
            });
            await refresh();
            message.success(action === "mark" ? "已标记官网公告停用；渠道与售价仍需单独处理" : "已撤销停用标记");
        } catch (error) {
            showError(error);
        } finally {
            setAiReviewBusy(false);
        }
    };

    const review = (id: string, approved: boolean) =>
        modal.confirm({
            title: approved ? "审核通过并生成不可变官方价版本？" : "驳回该价目候选？",
            content: "请核对官方模型 ID、币种、报价单位、免费/付费档、生效条件和来源证据。审核不会自动发布用户售价。",
            onOk: async () => {
                try {
                    await reviewOfficialPrice(id, approved, "");
                    await loadOverview(modelId, 1, overview?.officialPage || 1, candidateFilter);
                    setCandidateDetail(null);
                    message.success("审核结果已保存");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    const removeCandidate = (item: PriceCandidate) =>
        modal.confirm({
            title: `删除 ${item.sku} 的官方价目？`,
            content: "将物理删除这条候选、官方价版本及其未使用的计费契约，并清除历史销售版本中的关联。若当前仍绑定或已有真实按量调用，系统会拒绝删除；历史调用记录仍保留。",
            okText: "删除价目",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await deleteOfficialPrice(item.id, item.revision || null);
                    setActivationStatus(undefined);
                    await refresh(1);
                    message.success("价目已删除");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    const runPreview = async () => {
        setBusy(true);
        try {
            setPreview(await previewModelSales(policy, modelId, usage, selectedReference ? selectionScope : undefined));
        } catch (error) {
            setPreview(undefined);
            showError(error);
        } finally {
            setBusy(false);
        }
    };

    const adoptIndependentBinding = (binding: ModelPriceBinding) => {
        if (!binding.officialVersionId) return;
        const priceVersionIds = { ...policy.priceVersionIds };
        delete priceVersionIds[modelId];
        const nextPrice = [...(selectionOptions?.items.map((item) => item.version) || []), ...(overview?.boundVersions || []), ...(selectionBinding?.version ? [selectionBinding.version] : [])].find((item) => item.id === binding.officialVersionId);
        updatePolicy({
            ...policy,
            priceVersionIds,
            ...(nextPrice && !supportsDeepSeekTimePricing(nextPrice) ? { deepSeekUtcWindowModels: (policy.deepSeekUtcWindowModels || []).filter((id) => id !== modelId) } : {}),
            selectedPriceBindings: [
                ...(policy.selectedPriceBindings || []).filter((item) => item.logicalModelId !== modelId || item.scope !== binding.scope),
                { logicalModelId: modelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: binding.officialVersionId },
            ],
        });
        setUsage({});
    };

    const bindIndependentPrice = async () => {
        if (!modelId || !selectionVersionId || !selectionScope || !selectionEvidence.trim()) return;
        setSelectionBusy(true);
        try {
            const binding = await bindIndependentOfficialPrice(selectionVersionId, modelId, selectionOperation, selectionEvidence, selectionBinding?.revision || null);
            setSelectionBinding({ ...binding, version: selectionOptions?.items.find((item) => item.version.id === selectionVersionId)?.version || null });
            adoptIndependentBinding(binding);
            setSelectionEvidence("");
            message.success("独立选价已保存；请预览并发布用户售价");
        } catch (error) {
            showError(error);
        } finally {
            setSelectionBusy(false);
        }
    };

    const revokeIndependentPrice = () =>
        modal.confirm({
            title: "解除当前独立选价绑定？",
            content: "解除会保留历史选价与官网价；已发布售价须另外取消该范围的引用。",
            onOk: async () => {
                if (!selectionBinding || !selectionScope || !selectionEvidence.trim()) return;
                try {
                    const binding = await revokeIndependentOfficialPrice(modelId, selectionScope, selectionEvidence, selectionBinding.revision);
                    setSelectionBinding({ ...binding, version: null });
                    setSelectionVersionId("");
                    setSelectionEvidence("");
                    updatePolicy({ ...policy, selectedPriceBindings: (policy.selectedPriceBindings || []).filter((item) => item.logicalModelId !== modelId || item.scope !== selectionScope) });
                    message.success("选价绑定已解除；请单独取消已发布售价引用");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    const unbindPublishedSelection = () =>
        modal.confirm({
            title: "取消该范围已发布的用户售价？",
            content: "将发布不含此范围的新销售版本；其他模型和范围保持原引用，历史任务沿原冻结快照处理。",
            onOk: async () => {
                try {
                    await unbindModelSalesPrice(modelId, overview?.currentSalesVersionId || null, selectionScope);
                    updatePolicy({ ...policy, selectedPriceBindings: (policy.selectedPriceBindings || []).filter((item) => item.logicalModelId !== modelId || item.scope !== selectionScope) });
                    await refresh();
                    message.success("该范围已发布售价引用已取消");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    const publish = () =>
        modal.confirm({
            title: "发布新的用户销售版本？",
            content: "新版本供后续任务使用；发布本身不切换该模型的扣分方式。若该模型有效售价改变，已启用的按量扣分会自动回到固定积分，需重新核对真实影子报价。",
            onOk: async () => {
                if (!preview) return;
                try {
                    await publishModelSales(preview.policy, preview.currentSalesVersionId, preview.previewToken);
                    setPolicy(preview.policy);
                    await refresh();
                    setPreview(undefined);
                    message.success("销售版本已发布");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    const unbindCurrentPrice = () =>
        modal.confirm({
            title: "取消该模型当前官方价绑定？",
            content: "将发布一个不绑定该模型官方价的销售版本，之后该模型按固定积分收费；历史调用记录保留。",
            okText: "确认取消绑定",
            onOk: async () => {
                try {
                    await unbindModelSalesPrice(modelId, overview?.salesVersions.at(-1)?.id || null);
                    const priceVersionIds = { ...policy.priceVersionIds };
                    delete priceVersionIds[modelId];
                    setPolicy({ ...policy, priceVersionIds });
                    setPreview(undefined);
                    setActivationStatus(undefined);
                    await refresh();
                    message.success("当前官方价绑定已取消");
                } catch (error) {
                    showError(error);
                    throw error;
                }
            },
        });

    if (!overview) return <div className="py-12 text-center text-sm text-zinc-500">正在加载模型售价...</div>;
    const modelOptions = overview.models.map((item) => ({ value: item.id, label: `${item.name} (${item.id})` }));
    const modelPath = (selectedId?: string) => {
        const model = overview.models.find((item) => item.id === selectedId);
        return model ? [model.manufacturer || "未标厂商", model.capability, model.id] : undefined;
    };
    const modelTree = [...new Set(overview.models.map((item) => item.manufacturer || "未标厂商"))].sort().map((manufacturer) => ({
        value: manufacturer,
        label: manufacturer,
        children: [...new Set(overview.models.filter((item) => (item.manufacturer || "未标厂商") === manufacturer).map((item) => item.capability))].sort().map((capability) => ({
            value: capability,
            label: capabilityLabels[capability] || capability,
            children: overview.models.filter((item) => (item.manufacturer || "未标厂商") === manufacturer && item.capability === capability).map((item) => ({ value: item.id, label: `${item.name} (${item.id})` })),
        })),
    }));
    const displayPrice = (item: OfficialPriceInput["items"][number]) => {
        const original = `${item.price} ${item.currency}/${item.per} ${item.unit}`;
        if (item.currency !== "CNY" || !overview.exchangeRate?.cnyPerUsd) return original;
        return `${original}（≈ ${new Decimal(item.price).div(overview.exchangeRate.cnyPerUsd).toSignificantDigits(8)} USD/${item.per} ${item.unit}）`;
    };
    const candidateModelOptions = modelOptions.filter((item) => overview.candidateModelIds.includes(item.value));
    const section = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:p-5";
    const field = "grid min-w-0 gap-1 text-xs text-zinc-600 dark:text-zinc-300";
    const selectedCatalogManufacturer = catalogManufacturer || overview.officialSources[0]?.manufacturer || "";
    const visibleCatalog = catalogEntries.filter((entry) => entry.manufacturer === selectedCatalogManufacturer);
    const catalogSeries = visibleCatalog.filter((entry) => entry.kind === "series");
    const selectedCatalogSeries = catalogSeries.find((entry) => entry.id === catalogSelectedSeries);
    const filteredCatalogVersions = visibleCatalog.filter((entry) => {
        const series = visibleCatalog.find((item) => item.id === entry.parentId && item.kind === "series");
        return (
            entry.kind === "version" &&
            (!selectedCatalogSeries || entry.parentId === selectedCatalogSeries.id) &&
            (!catalogCapability || (series?.capability || entry.capability) === catalogCapability) &&
            (!catalogSearch.trim() || `${entry.name} ${entry.sku || ""}`.toLowerCase().includes(catalogSearch.trim().toLowerCase()))
        );
    });
    const linkedCatalogNames = (item: OfficialPriceInput) => {
        const entries = visiblePriceCatalog[item.manufacturer] || [];
        const exactSkuMatches = item.catalogVersionId ? [] : entries.filter((entry) => entry.kind === "version" && entry.sku === item.sku);
        const version = item.catalogVersionId ? entries.find((entry) => entry.id === item.catalogVersionId && entry.kind === "version") : exactSkuMatches.length === 1 ? exactSkuMatches[0] : undefined;
        const series = entries.find((entry) => entry.id === version?.parentId && entry.kind === "series");
        return version ? [series?.name, version.name].filter(Boolean).join(" / ") : null;
    };
    const catalogActions = (entry: OfficialPriceCatalogEntry) => ({
        items: [
            { key: "edit", label: "修改目录名称与证据" },
            { key: "delete", label: "删除未引用项", danger: true },
        ],
        onClick: ({ key }: { key: string }) => {
            if (key === "edit") openCatalogEdit(entry);
            else void deleteCatalogEntry(entry);
        },
    });
    const candidateCapability = candidate.capability || overview.models.find((entry) => entry.id === candidate.logicalModelId)?.capability;
    const candidateConditionChoices = officialPriceConditionChoices(candidate.manufacturer, candidateCapability || "", candidate.sku);
    const candidateItemConditionChoices = officialPriceItemConditionChoices(candidate.manufacturer, candidateCapability || "", candidate.sku);
    const candidateCatalogVersions = candidateCatalog.filter((entry) => {
        const series = candidateCatalog.find((item) => item.id === entry.parentId && item.kind === "series");
        return entry.kind === "version" && entry.manufacturer === candidate.manufacturer && (!candidateCapability || (series?.capability || entry.capability) === candidateCapability);
    });
    const catalogSeriesOptions = candidateCatalog.filter((entry) => entry.kind === "series" && entry.manufacturer === candidate.manufacturer && (!candidateCapability || entry.capability === candidateCapability)).map((entry) => entry.name);
    const legacySeriesOptions = showLegacySeries
        ? [...references.series, ...overview.models.filter((entry) => entry.manufacturer === candidate.manufacturer && (!candidateCapability || entry.capability === candidateCapability)).map((entry) => entry.series || "")]
        : [];
    const candidateSeriesOptions = [...new Set([...catalogSeriesOptions, ...legacySeriesOptions].filter(Boolean))].sort().map((value) => ({ value }));
    const openCatalogEditor = (kind: "series" | "version", fromCandidate: boolean) => {
        const manufacturer = fromCandidate ? candidate.manufacturer : selectedCatalogManufacturer;
        const entries = fromCandidate ? candidateCatalog : visibleCatalog;
        const parent = kind === "version" ? entries.find((entry) => entry.kind === "series" && entry.name === candidate.series && fromCandidate) || (fromCandidate ? undefined : selectedCatalogSeries) : undefined;
        if (!manufacturer) {
            message.info("请先选择官方厂商");
            return;
        }
        const source = overview.officialSources.find((entry) => entry.manufacturer === manufacturer);
        const model = overview.models.find((entry) => entry.id === candidate.logicalModelId);
        setCatalogDraft({
            manufacturer,
            parentId: parent?.id || "",
            name: fromCandidate ? (kind === "series" ? candidate.series : candidate.officialVersion) : "",
            capability: candidate.capability || model?.capability || "text",
            sku: fromCandidate && kind === "version" ? candidate.sku : "",
            sourceUrl: fromCandidate ? candidate.sourceUrl || source?.url || "" : source?.url || "",
            evidence: "",
        });
        setCatalogEditingEntry(null);
        setCatalogEditorFromCandidate(fromCandidate);
        setCatalogEditor(kind);
    };
    const openCatalogEdit = (entry: OfficialPriceCatalogEntry) => {
        setCatalogDraft({ manufacturer: entry.manufacturer, parentId: entry.parentId || "", name: entry.name, capability: entry.capability || "text", sku: entry.sku || "", sourceUrl: entry.sourceUrl, evidence: entry.evidence });
        setCatalogEditingEntry(entry);
        setCatalogEditorFromCandidate(false);
        setCatalogEditor(entry.kind);
    };
    const saveCatalogEntry = async () => {
        if (!catalogEditor) return;
        setCatalogBusy(true);
        try {
            const entry = catalogEditingEntry
                ? await editOfficialPriceCatalog({ ...catalogDraft, id: catalogEditingEntry.id, expected: catalogEditingEntry, kind: catalogEditor })
                : await createOfficialPriceCatalog({ ...catalogDraft, kind: catalogEditor });
            const replace = (current: OfficialPriceCatalogEntry[]) => (catalogEditingEntry ? current.map((item) => (item.id === entry.id ? entry : item)) : [...current, entry]);
            if (entry.manufacturer === selectedCatalogManufacturer) setCatalogEntries(replace);
            if (entry.manufacturer === candidate.manufacturer) setCandidateCatalog(replace);
            setVisiblePriceCatalog((current) => (current[entry.manufacturer] ? { ...current, [entry.manufacturer]: replace(current[entry.manufacturer]) } : current));
            if (catalogDetail?.id === entry.id) setCatalogDetail(entry);
            if (!catalogEditingEntry && catalogEditorFromCandidate) {
                if (entry.kind === "series") setCandidate((current) => ({ ...current, series: entry.name, officialVersion: "", sku: "", catalogVersionId: undefined, items: [], conditions: "" }));
                else setCandidate((current) => ({ ...current, series: candidateCatalog.find((item) => item.id === entry.parentId)?.name || "", officialVersion: entry.name, sku: entry.sku || "", catalogVersionId: entry.id, items: [] }));
            } else if (entry.kind === "series") setCatalogSelectedSeries(entry.id);
            setCatalogEditor(null);
            setCatalogEditingEntry(null);
            message.success(catalogEditingEntry ? "目录项已修改；历史价目未变更" : "已登记官网目录；价目仍需单独录入和审核");
        } catch (error) {
            showError(error);
        } finally {
            setCatalogBusy(false);
        }
    };
    const deleteCatalogEntry = async (entry: OfficialPriceCatalogEntry) => {
        try {
            const impact = await getOfficialPriceCatalogImpact(entry);
            if (impact.childVersions || impact.pending || impact.approved || impact.called) {
                modal.info({
                    title: "目录项仍被引用，不能删除",
                    content: `子型号 ${impact.childVersions} 个、待审价目 ${impact.pending} 条、已审核价目 ${impact.approved} 条${impact.called ? "，已有调用记录" : ""}。可在核对后修改展示名称，现有计费快照不会变化。`,
                });
                return;
            }
            modal.confirm({
                title: `删除目录项“${entry.name}”？`,
                content: "引用预检为零；保存时服务端会再次核对。删除目录项不会改变历史价目或计费。",
                okText: "删除目录项",
                okButtonProps: { danger: true },
                onOk: async () => {
                    try {
                        await deleteOfficialPriceCatalog(entry);
                        setCatalogEntries((current) => current.filter((item) => item.id !== entry.id));
                        setCandidateCatalog((current) => current.filter((item) => item.id !== entry.id));
                        if (catalogDetail?.id === entry.id) setCatalogDetail(null);
                        if (entry.id === catalogSelectedSeries) setCatalogSelectedSeries("");
                        message.success("目录项已删除；历史价目未变更");
                    } catch (error) {
                        showError(error);
                    }
                },
            });
        } catch (error) {
            showError(error);
        }
    };
    const openCandidate = (selectedModelId = "") => {
        setShowLegacySeries(false);
        setEditingCandidate(null);
        setStructurePickerOpen(false);
        setPriceReferenceReview(null);
        setPriceReferenceSource("");
        setCandidateOrigin("manual");
        const model = overview.models.find((item) => item.id === selectedModelId);
        const source = overview.officialSources.find((item) => item.manufacturer === model?.manufacturer);
        setCandidate({ ...emptyCandidate(), capability: model?.capability as OfficialPriceInput["capability"], manufacturer: model?.manufacturer || "", sourceUrl: source?.url || "" });
        setCandidateOpen(true);
    };
    const openCandidateEditor = (item: PriceCandidate) => {
        setShowLegacySeries(false);
        setEditingCandidate(item);
        setStructurePickerOpen(false);
        setPriceReferenceReview(null);
        setPriceReferenceSource("");
        setCandidateOrigin("manual");
        setCandidate({ ...item, items: item.items.map((price) => ({ ...price })) });
        setCandidateOpen(true);
    };
    const pager = (current: number, total: number, pageSize: number, onChange: (page: number) => void) => (
        <>
            <div className="sm:hidden">
                <Pagination size="small" simple current={current} pageSize={pageSize} total={total} showSizeChanger={false} onChange={onChange} />
            </div>
            <div className="hidden sm:block">
                <Pagination size="small" showQuickJumper current={current} pageSize={pageSize} total={total} showSizeChanger={false} onChange={onChange} />
            </div>
        </>
    );
    const textControls = (
        <>
            {textRuleOptions && salePrice && textRuleOptions.officialVersionId === salePrice.id && activationStatus?.admission.capability === "text" && (
                <div className="mt-4 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <b>纯文本缓存缺失规则</b>
                    <p className="mt-1 text-zinc-500">本模型所有渠道共用，默认不补零。真实返回的数值始终优先；缺少输入／输出或用量矛盾时仍保留预扣待核对。</p>
                    <div className="mt-3 flex flex-wrap gap-4">
                        <Checkbox checked={textRuleDraft.cacheReadMissingAsZero} disabled={!canPublish} onChange={(event) => setTextRuleDraft((current) => ({ ...current, cacheReadMissingAsZero: event.target.checked }))}>
                            缓存读取未报告按 0
                        </Checkbox>
                        <Checkbox checked={textRuleDraft.cacheWriteMissingAsZero} disabled={!canPublish} onChange={(event) => setTextRuleDraft((current) => ({ ...current, cacheWriteMissingAsZero: event.target.checked }))}>
                            缓存写入未报告按 0
                        </Checkbox>
                    </div>
                    <Input.TextArea
                        className="mt-3"
                        aria-label="文本缓存缺失规则核对依据"
                        rows={2}
                        value={textRuleDraft.evidence}
                        disabled={!canPublish}
                        placeholder="说明第三方渠道缺字段时如何按本模型官网价核算；不填写密钥或用户内容"
                        onChange={(event) => setTextRuleDraft((current) => ({ ...current, evidence: event.target.value }))}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                            size="small"
                            disabled={
                                !canPublish ||
                                !textRuleDraft.evidence.trim() ||
                                (textRuleOptions.rules[0]?.cacheReadMissingAsZero === textRuleDraft.cacheReadMissingAsZero &&
                                    textRuleOptions.rules[0]?.cacheWriteMissingAsZero === textRuleDraft.cacheWriteMissingAsZero &&
                                    textRuleOptions.rules[0]?.evidence === textRuleDraft.evidence)
                            }
                            loading={textRuleBusy}
                            onClick={() => void saveTextRule()}
                        >
                            审核并保存规则
                        </Button>
                        <span className="text-zinc-500">已审核版本：{textRuleOptions.rules[0]?.id.slice(0, 8) || "默认均关闭"}</span>
                        {activationStatus.activation?.enabled && activationStatus.activation.textUsageRuleId !== activationStatus.admission.textUsageRuleId && (
                            <span className="text-amber-700 dark:text-amber-300">新规则待影子报价核对；现有渠道继续按旧规则收费</span>
                        )}
                    </div>
                </div>
            )}
            {activationStatus?.admission.capability === "text" && textExceptions && (
                <div className="mt-3 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <div className="flex flex-wrap items-center gap-2">
                        <b>文本计费异常：{textExceptions.total} 笔</b>
                        <span className="text-zinc-500">待核对预扣合计 {textExceptions.heldPoints} 积分</span>
                        <Button size="small" onClick={() => setShowTextExceptions((value) => !value)}>
                            {showTextExceptions ? "收起记录" : "查看记录"}
                        </Button>
                        <Button size="small" onClick={() => void getTextPricingExceptions(modelId).then(setTextExceptions).catch(showError)}>
                            刷新异常
                        </Button>
                    </div>
                    {showTextExceptions && (
                        <div className="mt-2 space-y-2">
                            {textExceptions.items.map((item) => (
                                <div key={item.requestId} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                                    <div>
                                        {item.status === "pending-review" ? "待核对·未结算" : "已结算·身份／档位异常"} · {item.accountId ? `ID：${item.accountId.padStart(4, "0")}` : "用户信息不可用"} · {item.createdAt}
                                    </div>
                                    <div className="break-all text-zinc-500">
                                        任务 {item.taskId || "—"} · 请求 {item.requestId} · 渠道 {item.channelId || "—"}
                                    </div>
                                    <div className="break-all text-zinc-500">
                                        请求/响应型号 {item.requestedModel || "—"} / {item.reportedModel || "未报告"} · 请求/响应档位 {item.requestedTier || "Standard 契约"} / {item.reportedTier || "未报告"}
                                    </div>
                                    <div className="text-amber-700 dark:text-amber-300">{item.reasons.join("；")}</div>
                                    <details className="mt-1 text-zinc-500">
                                        <summary>脱敏用量与冻结版本</summary>
                                        <div className="break-all">
                                            价目 {item.officialVersionId} · 售价 {item.salesVersionId} · 规则 {item.ruleId || "默认关闭"} · 契约 {item.contractId}
                                        </div>
                                        {Object.entries(item.usageFields).map(([field, value]) => (
                                            <div key={field}>
                                                {field}: {value}
                                            </div>
                                        ))}
                                        {Object.entries(item.usageSources).map(([field, source]) => (
                                            <div key={`source-${field}`}>
                                                {field}：{source === "defaulted-zero" ? "按已审核规则计 0" : source === "reported-zero" ? "响应明确报告 0" : "按响应计量"}
                                            </div>
                                        ))}
                                    </details>
                                </div>
                            ))}
                            {textExceptions.offset > 0 && (
                                <Button
                                    size="small"
                                    onClick={() =>
                                        void getTextPricingExceptions(modelId, Math.max(0, textExceptions.offset - 20))
                                            .then(setTextExceptions)
                                            .catch(showError)
                                    }
                                >
                                    上一页
                                </Button>
                            )}
                            {textExceptions.total > textExceptions.offset + textExceptions.items.length && (
                                <Button
                                    size="small"
                                    onClick={() =>
                                        void getTextPricingExceptions(modelId, textExceptions.offset + 20)
                                            .then(setTextExceptions)
                                            .catch(showError)
                                    }
                                >
                                    下一页
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                发布售价只更新报价；只有在对应模型卡片明确点击“启用按量扣分”后，新任务才会按真实用量结算。
            </div>
            <nav aria-label="模型售价页内导航" className="flex flex-wrap gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                {(
                    [
                        ["workbench", "模型工作台"],
                        ["official", "官方价与证据"],
                        ["rules", "售价规则与折算"],
                    ] as const
                ).map(([key, label]) => (
                    <Button key={key} type={activeGroup === key ? "primary" : "default"} onClick={() => setActiveGroup(key)}>
                        {label}
                    </Button>
                ))}
            </nav>
            {activeGroup === "official" && (
                <nav aria-label="官方价与证据子导航" className="flex flex-wrap gap-2">
                    {(
                        [
                            ["pending", "待审价目"],
                            ["approved", "已审核版本"],
                            ["discovery", "官网发现档案"],
                            ["sources", "官网来源链接"],
                        ] as const
                    ).map(([key, label]) => (
                        <Button
                            key={key}
                            type={officialSub === key ? "primary" : "default"}
                            onClick={() => {
                                setOfficialSub(key);
                                if (key === "pending" || key === "approved") changeCandidateFilter({ ...candidateFilter, status: key === "pending" ? "pending" : "approved" });
                            }}
                        >
                            {label}
                        </Button>
                    ))}
                    {canReview && (
                        <Button type={officialSub === "catalog" ? "primary" : "default"} onClick={() => setOfficialSub("catalog")}>
                            官方型号目录
                        </Button>
                    )}
                </nav>
            )}
            {activeGroup === "rules" && (
                <nav aria-label="售价规则与折算子导航" className="flex flex-wrap gap-2">
                    {(
                        [
                            ["coefficients", "售价系数规则"],
                            ["currency", "汇率与币种折算"],
                        ] as const
                    ).map(([key, label]) => (
                        <Button key={key} type={rulesSub === key ? "primary" : "default"} onClick={() => setRulesSub(key)}>
                            {label}
                        </Button>
                    ))}
                </nav>
            )}

            {activeGroup === "official" && officialSub === "sources" && (
                <details className={section} open>
                    <summary className="cursor-pointer font-semibold">官网价格链接 · {overview.officialSources.length} 家厂商（点击查看或修改）</summary>
                    <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
                        <p className="text-xs text-zinc-500">按模型厂商打开官网价格页；管理员可新增或更新参考地址。厂商名称作为稳定标识。历史价目的证据链接独立保留。</p>
                        {canReview && (
                            <Button
                                onClick={() => {
                                    setSourceEditing(null);
                                    setSourceManufacturer("");
                                    setSourceDraft("");
                                    setSourceOpen(true);
                                }}
                            >
                                新增厂商官网链接
                            </Button>
                        )}
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {overview.officialSources.map((source) => (
                            <div key={source.manufacturer} className="min-w-0 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <b>{source.manufacturer}</b>
                                    {canReview && (
                                        <Button
                                            size="small"
                                            onClick={() => {
                                                setSourceEditing(source);
                                                setSourceManufacturer(source.manufacturer);
                                                setSourceDraft(source.url);
                                                setSourceOpen(true);
                                            }}
                                        >
                                            修改链接
                                        </Button>
                                    )}
                                </div>
                                <a className="mt-1 block break-all text-xs text-blue-700 underline dark:text-blue-300" href={source.url} target="_blank" rel="noreferrer">
                                    {source.url}
                                </a>
                                <p className="mt-1 text-xs text-zinc-500">{source.updatedAt ? `更新于 ${new Date(source.updatedAt).toLocaleString("zh-CN")}` : "预置官网参考地址"}</p>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {canReview && activeGroup === "official" && officialSub === "catalog" && (
                <section className={section}>
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                        <div>
                            <h2 className="font-semibold">官方型号目录</h2>
                            <p className="mt-1 text-xs text-zinc-500">按厂商直接登记精确型号；系列可选。历史审核价目与计费快照不随分类更名改变。</p>
                        </div>
                        <Button type="primary" onClick={() => openCatalogEditor("version", false)}>
                            新增官方型号
                        </Button>
                    </div>
                    <Select
                        aria-label="目录官方厂商"
                        className="mb-4 w-full sm:w-72"
                        showSearch
                        optionFilterProp="label"
                        value={selectedCatalogManufacturer || undefined}
                        options={overview.officialSources.map((source) => ({ value: source.manufacturer, label: source.manufacturer }))}
                        onChange={(manufacturer) => {
                            setCatalogManufacturer(manufacturer);
                            setCatalogEntries([]);
                            setCatalogSelectedSeries("");
                        }}
                    />
                    <div className="mb-4 grid gap-2 sm:grid-cols-2">
                        <Select
                            aria-label="目录模型能力"
                            allowClear
                            className="w-full"
                            value={catalogCapability || undefined}
                            placeholder="全部能力"
                            options={Object.entries(capabilityLabels).map(([value, label]) => ({ value, label }))}
                            onChange={(value) => setCatalogCapability(value || "")}
                        />
                        <Input aria-label="目录搜索型号" allowClear value={catalogSearch} placeholder="搜索官网型号或模型 ID" onChange={(event) => setCatalogSearch(event.target.value)} />
                    </div>
                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <h3 className="text-sm font-medium">系列筛选</h3>
                                <Button size="small" onClick={() => openCatalogEditor("series", false)}>
                                    新增系列
                                </Button>
                            </div>
                            <button type="button" className="w-full rounded-lg border border-zinc-200 p-3 text-left text-sm dark:border-zinc-800" onClick={() => setCatalogSelectedSeries("")}>
                                全部型号
                            </button>
                            {catalogSeries.map((entry) => (
                                <div key={entry.id} className={`flex items-start gap-2 rounded-lg border p-3 text-sm dark:border-zinc-800 ${selectedCatalogSeries?.id === entry.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-zinc-200"}`}>
                                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setCatalogSelectedSeries(entry.id)}>
                                        <b>{entry.name}</b>
                                        <span className="mt-1 block text-xs text-zinc-500">
                                            {capabilityLabels[entry.capability || ""] || entry.capability} · {visibleCatalog.filter((model) => model.parentId === entry.id).length} 个型号
                                        </span>
                                    </button>
                                    <Dropdown menu={catalogActions(entry)} trigger={["click"]}>
                                        <Button size="small" aria-label={`${entry.name} 操作菜单`}>
                                            ⋯
                                        </Button>
                                    </Dropdown>
                                </div>
                            ))}
                            {!catalogSeries.length && <Empty description="该厂商暂无系列目录；仍可在价目表单手动录入" />}
                        </div>
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm font-medium">{selectedCatalogSeries ? "该系列的官网型号" : "全部官网型号"}</h3>
                            </div>
                            {filteredCatalogVersions.map((entry) => (
                                <div key={entry.id} className="flex items-start gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setCatalogDetail(entry)}>
                                        <b>{entry.name}</b>
                                        <span className="mt-1 block break-all text-xs text-zinc-500">
                                            {visibleCatalog.find((series) => series.id === entry.parentId)?.name || "未分类"} · 官方模型 ID：{entry.sku}
                                        </span>
                                    </button>
                                    <Dropdown menu={catalogActions(entry)} trigger={["click"]}>
                                        <Button size="small" aria-label={`${entry.name} 操作菜单`}>
                                            ⋯
                                        </Button>
                                    </Dropdown>
                                </div>
                            ))}
                            {!filteredCatalogVersions.length && <Empty description="没有匹配的官网型号" />}
                        </div>
                    </div>
                </section>
            )}

            <Drawer title="官网型号详情" width="min(640px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open={Boolean(catalogDetail)} onClose={() => setCatalogDetail(null)}>
                {catalogDetail && (
                    <div className="space-y-3 text-sm">
                        <p>
                            <b>{catalogDetail.name}</b> · {catalogDetail.manufacturer}
                        </p>
                        <p>官方系列：{catalogEntries.find((entry) => entry.id === catalogDetail.parentId)?.name || "未分类"}</p>
                        <p className="break-all">官方模型 ID：{catalogDetail.sku}</p>
                        <p>目录引用：{catalogImpact ? `待审 ${catalogImpact.pending} 条 · 已审核 ${catalogImpact.approved} 条 · ${catalogImpact.called ? "已有调用" : "未发现已审核价目关联的调用"}` : "正在核对…"}</p>
                        <p className="whitespace-pre-wrap break-words">命名依据：{catalogDetail.evidence}</p>
                        <a href={catalogDetail.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline dark:text-blue-300">
                            官网来源：{catalogDetail.sourceUrl}
                        </a>
                        <p className="text-xs text-zinc-500">
                            目录 ID：{catalogDetail.id} · 建立于 {catalogDetail.createdAt}
                            {catalogDetail.updatedAt ? ` · 修改于 ${catalogDetail.updatedAt}` : ""}
                        </p>
                        <p className="text-xs text-zinc-500">重命名仅改变当前展示；已审核价格、上游调用 ID 与历史计费不变。</p>
                    </div>
                )}
            </Drawer>

            {activeGroup === "workbench" && (
                <section className={section}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h2 className="font-semibold">模型工作台</h2>
                            <p className="mt-1 text-xs text-zinc-500">按厂商、能力与状态查找模型；点击模型后核对价目、渠道和计费条件。</p>
                        </div>
                        <span className="text-xs text-zinc-500">当前筛选 {overview.workbenchTotal} 个模型</span>
                    </div>
                    <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <button
                            type="button"
                            className="rounded-lg border border-zinc-200 p-3 text-left text-sm hover:border-blue-400 dark:border-zinc-800"
                            onClick={() => {
                                setActiveGroup("official");
                                setOfficialSub("pending");
                                changeCandidateFilter({ status: "pending" });
                            }}
                        >
                            待审官方价 · {overview.workbenchTodo?.pendingOfficialModels ?? "—"} 个启用模型
                        </button>
                        <button type="button" className="rounded-lg border border-zinc-200 p-3 text-left text-sm hover:border-blue-400 dark:border-zinc-800" onClick={() => changeWorkbenchFilter({ enabled: "active", status: "sales-unpublished" })}>
                            待发布售价 · {overview.workbenchTodo?.unpublishedSalesModels ?? "—"} 个启用模型
                        </button>
                        <button type="button" className="rounded-lg border border-zinc-200 p-3 text-left text-sm hover:border-blue-400 dark:border-zinc-800" onClick={() => changeWorkbenchFilter({ enabled: "active", status: "channel-pending" })}>
                            待验收渠道 · {overview.workbenchTodo?.pendingBindings ?? "—"} 个启用绑定
                            <span className="block text-xs text-zinc-500">{overview.workbenchTodo?.reviewNeededBindings ? `另有 ${overview.workbenchTodo.reviewNeededBindings} 个旧记录绑定待核对` : "按当前契约与激活记录核对"}</span>
                        </button>
                        {canPublish && (
                            <button
                                type="button"
                                className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50"
                                onClick={() => {
                                    setGlobalExceptionModel("");
                                    setGlobalExceptionChannel("");
                                    setGlobalExceptionStatus(undefined);
                                    setGlobalExceptionOpen(true);
                                    loadGlobalExceptions("", "", undefined);
                                }}
                            >
                                文本计费异常 · {globalExceptionSummary?.total ?? "加载中"} 笔<span className="block text-xs">含已关闭模型 · 待核对预扣 {globalExceptionSummary?.heldPoints ?? "—"} 积分</span>
                            </button>
                        )}
                    </div>
                    <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                        <Input.Search
                            aria-label="工作台模型搜索"
                            placeholder="模型、渠道或上游型号"
                            value={workbenchSearch}
                            onChange={(event) => setWorkbenchSearch(event.target.value)}
                            onSearch={(name) => changeWorkbenchFilter({ ...workbenchFilter, name: name.trim() || undefined })}
                        />
                        <Select
                            aria-label="工作台厂商筛选"
                            className="w-full"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            placeholder="全部厂商"
                            value={workbenchFilter.manufacturer}
                            options={overview.workbenchManufacturers.map((value) => ({ value, label: value }))}
                            onChange={(manufacturer) => changeWorkbenchFilter({ ...workbenchFilter, manufacturer })}
                        />
                        <Select
                            aria-label="工作台能力筛选"
                            className="w-full"
                            allowClear
                            placeholder="全部能力"
                            value={workbenchFilter.capability}
                            options={Object.entries(capabilityLabels).map(([value, label]) => ({ value, label }))}
                            onChange={(capability) => changeWorkbenchFilter({ ...workbenchFilter, capability })}
                        />
                        <Select
                            aria-label="工作台启用状态"
                            className="w-full"
                            value={workbenchFilter.enabled || "active"}
                            options={[
                                { value: "active", label: "已启用" },
                                { value: "disabled", label: "已关闭" },
                                { value: "all", label: "全部模型" },
                            ]}
                            onChange={(enabled) => changeWorkbenchFilter({ ...workbenchFilter, enabled })}
                        />
                        <Select
                            aria-label="工作台工作状态"
                            className="w-full"
                            allowClear
                            placeholder="全部工作状态"
                            value={workbenchFilter.status}
                            options={[...Object.entries(unpricedStatusLabel).map(([value, label]) => ({ value, label })), { value: "published", label: "有已发布售价" }, { value: "channel-pending", label: "渠道待验收或待核对" }]}
                            onChange={(status) => changeWorkbenchFilter({ ...workbenchFilter, status })}
                        />
                    </div>
                    <div className="space-y-2">
                        {overview.workbenchModels.map((item, index) => (
                            <div key={item.id}>
                                {!workbenchFilter.manufacturer && (index === 0 || overview.workbenchModels[index - 1]?.manufacturer !== item.manufacturer) && <h3 className="pb-1 pt-2 text-sm font-semibold">{item.manufacturer || "未标厂商"}</h3>}
                                <div data-testid={`pricing-model-${item.id}`} className="grid min-w-0 gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] sm:items-center">
                                    <div className="min-w-0">
                                        <b className="break-all text-sm">{item.name}</b>
                                        <p className="break-all text-xs text-zinc-500">
                                            {item.id} · {capabilityLabels[item.capability] || item.capability} · {item.enabled ? "已启用" : "已关闭"}
                                        </p>
                                    </div>
                                    <span className="text-xs">官方价：{item.approvedPrice ? "已有审核版本" : item.status === "pending-review" ? "候选待审核" : "未审核"}</span>
                                    <span className="min-w-0 break-words text-xs">
                                        售价：{item.publishedScopes.length ? `${item.publishedScopes.map((scope) => publishedScopeLabels[scope] || scope).join("、")}已发布` : item.publishedPrice ? "旧式模型价已发布" : "未发布"}
                                    </span>
                                    <span className="text-xs">
                                        运行/扣费：
                                        {item.billingMode === "disabled"
                                            ? "已关闭，不承接新请求"
                                            : item.billingMode === "metered"
                                              ? "按量运行"
                                              : item.billingMode === "paused"
                                                ? "按量暂停，待核对"
                                                : item.billingMode === "review-needed"
                                                  ? "旧激活记录待核对"
                                                  : "固定积分"}
                                        <br />
                                        {item.billingBindingSlots > item.bindingCount ? "操作渠道" : "渠道"}：{item.activeBindings}/{item.billingBindingSlots} 个已纳入按量，{item.qualifiedBindings} 个契约齐备
                                    </span>
                                    <Button size="small" onClick={() => openModel(item.id)}>
                                        查看与处理
                                    </Button>
                                    {item.blocker && <p className="text-xs text-amber-700 dark:text-amber-300 sm:col-span-full">待处理：{item.blocker}</p>}
                                </div>
                            </div>
                        ))}
                        {!overview.workbenchModels.length && <Empty description="当前筛选下没有模型" />}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span>共 {overview.workbenchTotal} 个</span>
                        {pager(
                            overview.workbenchPage,
                            overview.workbenchTotal,
                            overview.pageSize,
                            (page) => void loadOverview(modelId, overview.candidatePage, overview.officialPage, candidateFilter, overview.unpricedPage, unpricedFilter, page).catch(showError),
                        )}
                    </div>
                </section>
            )}

            {activeGroup === "official" && (officialSub === "pending" || officialSub === "approved") && (
                <section className={section}>
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h2 className="font-semibold">{officialSub === "pending" ? "待审价目候选" : "已审核价目记录"}</h2>
                            <p className="mt-1 text-xs text-zinc-500">先提交带官方证据的待审核候选，再由上游配置管理员核对并发布不可变价目版本。</p>
                        </div>
                        {canReview && officialSub === "pending" && (
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    onClick={() => {
                                        setAiDiscoveryOnly(false);
                                        setAiTargetOfficialModelId("");
                                        setAiReviewOpen(true);
                                    }}
                                >
                                    AI 核对官网价目
                                </Button>
                                <Button type="primary" onClick={() => openCandidate()}>
                                    录入官方价目
                                </Button>
                            </div>
                        )}
                    </div>
                    <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        <Select
                            aria-label="价目厂商筛选"
                            className="w-full"
                            allowClear
                            placeholder="全部厂商"
                            value={candidateFilter.manufacturer}
                            options={overview.manufacturers.map((manufacturer) => ({ value: manufacturer, label: manufacturer }))}
                            onChange={(manufacturer) => changeCandidateFilter({ ...candidateFilter, manufacturer, modelId: undefined })}
                        />
                        <Select
                            aria-label="价目模型筛选"
                            className="w-full"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            placeholder={candidateFilter.manufacturer ? `${candidateFilter.manufacturer} 全部模型` : "全部模型"}
                            value={candidateFilter.modelId}
                            options={
                                officialSub === "approved" ? modelOptions.filter((item) => !candidateFilter.manufacturer || overview.models.find((model) => model.id === item.value)?.manufacturer === candidateFilter.manufacturer) : candidateModelOptions
                            }
                            onChange={(selectedModelId) => changeCandidateFilter({ ...candidateFilter, modelId: selectedModelId })}
                        />
                        {officialSub === "pending" && (
                            <Select<"pending" | "rejected" | "all">
                                aria-label="价目状态筛选"
                                className="w-full"
                                value={candidateFilter.status === "pending" || candidateFilter.status === "rejected" ? candidateFilter.status : "all"}
                                options={[
                                    { value: "pending", label: "待审核" },
                                    { value: "rejected", label: "已驳回" },
                                    { value: "all", label: "全部候选" },
                                ]}
                                onChange={(status) => changeCandidateFilter({ ...candidateFilter, status: status === "all" ? undefined : status })}
                            />
                        )}
                    </div>
                    {officialSub === "pending" && candidateFilter.status === "pending" && canReview && confirmedObservationPage && confirmedObservationPage.total > 0 && (
                        <div className="mb-4 space-y-2 rounded-xl border border-blue-200 p-3 dark:border-blue-900">
                            <div>
                                <h3 className="font-medium">已确认发现 · 待形成价目候选</h3>
                                <p className="text-xs text-zinc-500">逐档核对官网分项和证据后提交候选；审核通过后，再按实际渠道型号关联逻辑模型并配置售价。</p>
                            </div>
                            {confirmedObservationPage.observations.map((item) => {
                                const submitted = overview.candidates.some((candidate) => candidate.manufacturer === item.manufacturer && candidate.sku.toLowerCase() === item.officialModelId.toLowerCase());
                                const variants = officialPriceObservationVariants(item);
                                return (
                                    <div key={item.id} className="space-y-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <b className="break-all">{item.officialModelId}</b>
                                            <Tag color="gold">待核对并补齐</Tag>
                                            {submitted && <Tag color="blue">已有同型号候选，请核对档位</Tag>}
                                        </div>
                                        <p className="text-xs text-zinc-500">
                                            {item.manufacturer} · {variants.length} 个待核对价格组 · 来源：
                                            <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-blue-700 dark:text-blue-300">
                                                {item.sourceUrl}
                                            </a>
                                        </p>
                                        {variants.map((variant, index) => {
                                            const missing = officialPriceDraftIssues({
                                                ...emptyCandidate(),
                                                manufacturer: item.manufacturer,
                                                series: variant.suggestedSeries || "",
                                                officialVersion: variant.suggestedVersion || "",
                                                sku: item.officialModelId,
                                                tier: "",
                                                conditions: variant.conditions,
                                                sourceUrl: item.sourceUrl,
                                                evidence: variant.evidence,
                                                observedAt: item.observedAt,
                                                items: variant.items,
                                            });
                                            return (
                                                <div key={index} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                                    <p>
                                                        价格组 {index + 1} · {variant.conditions || "适用条件待确认"} · {variant.items.length} 个计费分项{variant.amendment ? ` · 人工修订第 ${variant.amendment.revision} 版` : ""}
                                                    </p>
                                                    <p className="mt-1">
                                                        AI 建议：{variant.suggestedTier || "收费档待确认"}
                                                        {variant.suggestedProcessingTier ? ` / ${variant.suggestedProcessingTier}` : ""}
                                                    </p>
                                                    <p className="mt-1 text-amber-700 dark:text-amber-300">待补齐或确认：{missing.join("、") || "逐项核对官网证据"}</p>
                                                    <Button size="small" className="mt-2" onClick={() => openObservationDraft(item, variant)}>
                                                        编辑分项并填写候选
                                                    </Button>
                                                </div>
                                            );
                                        })}
                                        <div className="flex flex-wrap items-center gap-2">
                                            {!submitted && (
                                                <Button
                                                    size="small"
                                                    danger
                                                    onClick={() => {
                                                        setInvalidationTarget(item);
                                                        setInvalidationReason("");
                                                    }}
                                                >
                                                    撤销确认
                                                </Button>
                                            )}
                                        </div>
                                        <details className="text-xs">
                                            <summary className="cursor-pointer text-blue-700 dark:text-blue-300">查看官网证据与全部分项</summary>
                                            <div className="mt-2 space-y-2 break-all">
                                                {variants.map((variant, index) => (
                                                    <div key={index} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                                                        <b>价格组 {index + 1}</b>
                                                        {variant.items.map((price) => (
                                                            <p key={price.key}>
                                                                {price.key} · {price.condition || "条件待核对"}：{displayPrice(price)}
                                                            </p>
                                                        ))}
                                                        <p>适用条件：{variant.conditions || "待补齐"}</p>
                                                        {variant.headerEvidence && <p>表头证据：{variant.headerEvidence}</p>}
                                                        <p className="whitespace-pre-wrap">{variant.evidence}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    </div>
                                );
                            })}
                            {pager(confirmedObservationPage.page, confirmedObservationPage.total, confirmedObservationPage.pageSize, (page) => void loadConfirmedObservations(page))}
                        </div>
                    )}
                    <div className="space-y-2">
                        {officialSub === "pending" &&
                            overview.candidates.map((item) => (
                                <div key={item.id} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-start">
                                        <div className="min-w-0 text-sm">
                                            <b className="break-all">{item.sku}</b>
                                            {item.logicalModelId ? (
                                                <span> ↔ {item.logicalModelId}</span>
                                            ) : (
                                                <Tag className="ml-2" color="gold">
                                                    待关联逻辑模型
                                                </Tag>
                                            )}
                                            <div className="text-xs text-zinc-500">
                                                {item.manufacturer} / {linkedCatalogNames(item) || `${item.series} / ${item.officialVersion}`} · {item.tier === "free" ? "免费档" : "付费档"}{" "}
                                                {item.manufacturer === "OpenAI" && <Tag className="ml-1">{processingTierLabel(item)}</Tag>}
                                                {linkedCatalogNames(item) && linkedCatalogNames(item) !== `${item.series} / ${item.officialVersion}` && (
                                                    <span className="block">
                                                        提交时：{item.series} / {item.officialVersion}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="min-w-0 text-xs text-zinc-600 dark:text-zinc-300">
                                            {item.items.length} 项：
                                            {item.items
                                                .slice(0, 2)
                                                .map((price) => `${price.key} ${displayPrice(price)}`)
                                                .join("；")}
                                            {item.items.length > 2 ? "；更多见详情" : ""}
                                        </div>
                                        <Tag color={item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "gold"}>{item.status === "approved" ? "已审核" : item.status === "rejected" ? "已驳回" : "待审核"}</Tag>
                                    </div>
                                    <Button className="mt-2" size="small" onClick={() => setCandidateDetail(item)}>
                                        查看全部分项、适用条件与证据
                                    </Button>
                                </div>
                            ))}
                        {officialSub === "pending" && !overview.candidates.length && (
                            <Empty description={confirmedObservationPage?.total && candidateFilter.status === "pending" ? "尚无正式价目候选，请先处理上方已确认发现" : overview.candidateAllTotal ? "当前筛选下无待审价目" : "尚无官方价目候选"} />
                        )}
                        {officialSub === "approved" &&
                            overview.approvedVersions.map((item) => (
                                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                                    <div>
                                        <b>{item.sku}</b>
                                        {item.logicalModelId ? (
                                            <span> ↔ {item.logicalModelId}</span>
                                        ) : (
                                            <Tag className="ml-2" color="gold">
                                                已审核 · 可供独立选价
                                            </Tag>
                                        )}
                                        <p className="text-xs text-zinc-500">
                                            {item.manufacturer} · {linkedCatalogNames(item) || item.officialVersion} · {item.conditions} · {item.items.length} 项 · 审核于 {item.publishedAt}
                                        </p>
                                    </div>
                                    <Button
                                        size="small"
                                        onClick={() => {
                                            setApprovedDetail(item);
                                            setLinkTargetModelId("");
                                        }}
                                    >
                                        查看不可变版本
                                    </Button>
                                </div>
                            ))}
                        {officialSub === "approved" && !overview.approvedVersions.length && <Empty description="当前筛选下没有已审核价目" />}
                    </div>
                    {officialSub === "pending" && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span>
                                当前筛选 {overview.candidateTotal} 条 / 全部 {overview.candidateAllTotal} 条
                            </span>
                            {pager(overview.candidatePage, overview.candidateTotal, overview.pageSize, (page) => void refresh(page))}
                        </div>
                    )}
                    {officialSub === "approved" && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span>共 {overview.approvedTotal} 个</span>
                            {pager(overview.officialPage, overview.approvedTotal, overview.pageSize, (page) => void refresh(overview.candidatePage, page))}
                        </div>
                    )}
                </section>
            )}

            <Drawer title="核对官方价目候选" width="min(880px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open={Boolean(candidateDetail)} onClose={() => setCandidateDetail(null)}>
                {candidateDetail && (
                    <div className="space-y-4 text-sm">
                        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <b className="break-all">{candidateDetail.sku}</b>
                            {candidateDetail.logicalModelId ? (
                                <span> ↔ {candidateDetail.logicalModelId}</span>
                            ) : (
                                <Tag className="ml-2" color="gold">
                                    待关联逻辑模型
                                </Tag>
                            )}
                            <p className="mt-1 text-zinc-500">
                                {candidateDetail.manufacturer} / {linkedCatalogNames(candidateDetail) || `${candidateDetail.series} / ${candidateDetail.officialVersion}`} · {candidateDetail.tier === "free" ? "免费档" : "付费档"}
                                {processingTierLabel(candidateDetail) ? ` · ${processingTierLabel(candidateDetail)}` : ""}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                                提交快照：{candidateDetail.series} / {candidateDetail.officialVersion} · {candidateDetail.catalogVersionId ? `目录 ID ${candidateDetail.catalogVersionId}` : "未关联目录"}
                            </p>
                            <p className="mt-1 text-zinc-500">
                                候选状态：{candidateDetail.status === "pending" ? "待审核" : candidateDetail.status === "approved" ? "已审核" : "已驳回"} · 来源类型：{candidateDetail.sourceKind || "未标注"}
                            </p>
                        </div>
                        <div className="space-y-2">
                            <h3 className="font-semibold">全部官方分项</h3>
                            {candidateDetail.items.map((price) => (
                                <div key={price.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <b>{price.key}</b>
                                    <p>{displayPrice(price)}</p>
                                    <p className="text-zinc-500">适用条件：{price.condition || "未限定"}</p>
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <p>整体适用条件：{candidateDetail.conditions || "未填写"}</p>
                            <p>
                                有效期：{candidateDetail.effectiveFrom || "未限定"} 至 {candidateDetail.effectiveTo || "未限定"}
                            </p>
                            <p className="whitespace-pre-wrap break-words">证据：{candidateDetail.evidence || "未填写"}</p>
                            <p>观察时间：{candidateDetail.observedAt || "未填写"}</p>
                            <a href={candidateDetail.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline dark:text-blue-300">
                                官网证据：{candidateDetail.sourceUrl}
                            </a>
                        </div>
                        <div className="space-y-1 text-xs text-zinc-500">
                            <p>
                                提交：{candidateDetail.createdAt} · {candidateDetail.createdBy}
                            </p>
                            <p>
                                修订：{candidateDetail.revisedAt || "无"} · {candidateDetail.revisedBy || "无"}
                            </p>
                            <p>
                                审核：{candidateDetail.reviewedAt || "未审核"} · {candidateDetail.reviewedBy || "无"}
                            </p>
                            {candidateDetail.reviewNote && <p>审核说明：{candidateDetail.reviewNote}</p>}
                        </div>
                        {isMainlandByteDancePrice(candidateDetail) && <p className="text-amber-700 dark:text-amber-300">此候选引用火山方舟国内报价，不适用于 BytePlus 海外定价。</p>}
                        {canReview && (
                            <div className="flex flex-wrap gap-2">
                                {candidateDetail.status === "pending" && (
                                    <>
                                        <Button disabled={isMainlandByteDancePrice(candidateDetail)} onClick={() => review(candidateDetail.id, true)}>
                                            审核通过
                                        </Button>
                                        <Button onClick={() => review(candidateDetail.id, false)}>驳回</Button>
                                    </>
                                )}
                                <Button
                                    onClick={() => {
                                        openCandidateEditor(candidateDetail);
                                        setCandidateDetail(null);
                                    }}
                                >
                                    修改候选
                                </Button>
                                <Button
                                    danger
                                    disabled={Boolean(candidateDetail.approvedVersionId && overview.salesVersions.at(-1)?.priceVersionIds[candidateDetail.logicalModelId] === candidateDetail.approvedVersionId)}
                                    onClick={() => {
                                        removeCandidate(candidateDetail);
                                        setCandidateDetail(null);
                                    }}
                                >
                                    删除候选
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </Drawer>

            <Drawer title="全部模型的文本计费异常" width="min(900px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open={globalExceptionOpen} onClose={() => setGlobalExceptionOpen(false)}>
                <div className="space-y-3">
                    <p className="text-sm text-zinc-500">包括已关闭模型；查看记录不会改变预扣或结算。</p>
                    <div className="grid gap-2 sm:grid-cols-3">
                        <Select
                            aria-label="异常模型筛选"
                            className="w-full"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            placeholder="全部模型"
                            value={globalExceptionModel || undefined}
                            options={modelOptions}
                            onChange={(value) => {
                                const next = value || "";
                                setGlobalExceptionModel(next);
                                loadGlobalExceptions(next);
                            }}
                        />
                        <Input.Search
                            aria-label="异常渠道 ID 筛选"
                            placeholder="渠道 ID"
                            value={globalExceptionChannel}
                            onChange={(event) => setGlobalExceptionChannel(event.target.value)}
                            onSearch={(value) => {
                                const next = value.trim();
                                setGlobalExceptionChannel(next);
                                loadGlobalExceptions(globalExceptionModel, next);
                            }}
                        />
                        <Select
                            aria-label="异常状态筛选"
                            className="w-full"
                            allowClear
                            placeholder="全部异常状态"
                            value={globalExceptionStatus}
                            options={[
                                { value: "pending-review", label: "待核对 · 未结算" },
                                { value: "settled-warning", label: "已结算 · 警告" },
                            ]}
                            onChange={(value) => {
                                setGlobalExceptionStatus(value);
                                loadGlobalExceptions(globalExceptionModel, globalExceptionChannel, value);
                            }}
                        />
                    </div>
                    <p className="text-xs text-zinc-500">
                        共 {globalExceptions?.total ?? "—"} 笔 · 待核对预扣 {globalExceptions?.heldPoints ?? "—"} 积分
                    </p>
                    {globalExceptions?.items.map((item) => (
                        <div key={item.requestId} className="space-y-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <b>{item.status === "pending-review" ? "待核对 · 未结算" : "已结算 · 警告"}</b>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        setGlobalExceptionOpen(false);
                                        openModel(item.modelId);
                                    }}
                                >
                                    查看模型 {item.modelId}
                                </Button>
                            </div>
                            <p className="break-all text-zinc-500">
                                {item.createdAt} · {item.accountId ? `ID：${item.accountId.padStart(4, "0")}` : "用户信息不可用"} · 任务 {item.taskId || "—"} · 请求 {item.requestId}
                            </p>
                            <p>
                                渠道：{item.channelName ? `${item.channelName}（当前名称）` : "名称未记录"} · ID：{item.channelId || "未记录"} · {item.status === "pending-review" ? `待核对预扣 ${item.heldPoints || "0"} 积分` : "已结算，查看警告原因"}
                            </p>
                            <p>
                                任务结果：{item.resultState === "result-recorded" ? "已有生成结果记录，客户端交付状态未确认" : "未确认"}
                                {item.taskStatus ? ` · 任务状态 ${item.taskStatus}` : ""}
                            </p>
                            <p>
                                请求／响应型号：{item.requestedModel || "—"} / {item.reportedModel || "未报告"} · 档位：{item.requestedTier || "Standard 契约"} / {item.reportedTier || "未报告"}
                            </p>
                            <p className="text-amber-700 dark:text-amber-300">{item.reasons.join("；")}</p>
                            <p className="text-zinc-500">下一步：按请求 ID 核对任务结果、上游用量及冻结契约；确认前不改动预扣和历史账单。</p>
                            <details>
                                <summary className="cursor-pointer">用量来源与冻结版本</summary>
                                <div className="mt-2 space-y-1 break-all text-zinc-500">
                                    <p>
                                        官方价 {item.officialVersionId} · 售价 {item.salesVersionId} · 规则 {item.ruleId || "默认关闭"} · 契约 {item.contractId}
                                    </p>
                                    {Object.entries(item.meterStates).map(([field, state]) => (
                                        <p key={field}>
                                            官方分项 {field}：{state === "reviewed-zero" ? "按已审核规则补 0" : state === "reported-zero" ? "响应明确报告 0" : state === "reported-positive" ? "响应正数" : "缺失或矛盾，待核对"}
                                        </p>
                                    ))}
                                    {Object.entries(item.usageFields).map(([field, value]) => (
                                        <p key={`raw-${field}`}>
                                            上游字段 {field}: {value}
                                        </p>
                                    ))}
                                </div>
                            </details>
                        </div>
                    ))}
                    {globalExceptions?.total === 0 && <Empty description="暂无文本计费异常" />}
                    {globalExceptions && (
                        <div className="flex items-center gap-2 text-xs text-zinc-500">
                            第 {Math.floor(globalExceptions.offset / 20) + 1} 页
                            <Button size="small" disabled={globalExceptions.offset === 0} onClick={() => loadGlobalExceptions(globalExceptionModel, globalExceptionChannel, globalExceptionStatus, Math.max(0, globalExceptions.offset - 20))}>
                                上一页
                            </Button>
                            <Button
                                size="small"
                                disabled={globalExceptions.offset + globalExceptions.items.length >= globalExceptions.total}
                                onClick={() => loadGlobalExceptions(globalExceptionModel, globalExceptionChannel, globalExceptionStatus, globalExceptions.offset + 20)}
                            >
                                下一页
                            </Button>
                        </div>
                    )}
                </div>
            </Drawer>

            <Drawer title="已审核官方价版本" width="min(880px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open={Boolean(approvedDetail)} onClose={() => setApprovedDetail(null)}>
                {approvedDetail && (
                    <div className="space-y-4 text-sm">
                        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <b className="break-all">{approvedDetail.sku}</b>
                            {approvedDetail.logicalModelId ? (
                                <span> ↔ {approvedDetail.logicalModelId}</span>
                            ) : (
                                <Tag className="ml-2" color="gold">
                                    已审核 · 可供独立选价
                                </Tag>
                            )}
                            <p className="mt-1 text-zinc-500">
                                {approvedDetail.manufacturer} / {linkedCatalogNames(approvedDetail) || `${approvedDetail.series} / ${approvedDetail.officialVersion}`} · {approvedDetail.tier === "free" ? "免费档" : "付费档"}
                                {processingTierLabel(approvedDetail) ? ` · ${processingTierLabel(approvedDetail)}` : ""}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                                审核快照：{approvedDetail.series} / {approvedDetail.officialVersion} · {approvedDetail.catalogVersionId ? `目录 ID ${approvedDetail.catalogVersionId}` : "未关联目录"}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                                版本 ID：{approvedDetail.id} · 审核于 {approvedDetail.publishedAt} · 审核人 {approvedDetail.reviewedBy}
                            </p>
                            {approvedDetail.linkedFromVersionId && <p className="mt-1 text-xs text-zinc-500">关联来源版本：{approvedDetail.linkedFromVersionId}</p>}
                        </div>
                        {!approvedDetail.logicalModelId && canReview && (
                            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="mb-2">选择逻辑模型后，前往模型售价按操作保存独立选价；官网价版本保持原样，售价须单独发布。</p>
                                <div className="flex flex-wrap gap-2">
                                    <Select
                                        aria-label="选择独立选价逻辑模型"
                                        className="min-w-56 flex-1"
                                        showSearch
                                        optionFilterProp="label"
                                        placeholder="选择同厂商、同能力模型"
                                        value={linkTargetModelId || undefined}
                                        options={modelOptions.filter((option) => {
                                            const model = overview.models.find((entry) => entry.id === option.value);
                                            return model?.manufacturer === approvedDetail.manufacturer && model.capability === approvedDetail.capability;
                                        })}
                                        onChange={setLinkTargetModelId}
                                    />
                                    <Button
                                        disabled={!linkTargetModelId}
                                        onClick={() => {
                                            setApprovedDetail(null);
                                            setActiveGroup("workbench");
                                            openModel(linkTargetModelId);
                                            setModelDetailView("conditions");
                                        }}
                                    >
                                        前往独立选价
                                    </Button>
                                </div>
                            </div>
                        )}
                        <div className="space-y-2">
                            <h3 className="font-semibold">全部分项</h3>
                            {approvedDetail.items.map((item) => (
                                <div key={item.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <b>{item.key}</b>
                                    <p>{displayPrice(item)}</p>
                                    <p className="text-zinc-500">本项适用条件：{item.condition || "未限定"}</p>
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <p>整体适用条件：{approvedDetail.conditions || "未填写"}</p>
                            <p>
                                生效：{approvedDetail.effectiveFrom || "未限定"} 至 {approvedDetail.effectiveTo || "未限定"}
                            </p>
                            <p className="whitespace-pre-wrap break-words">证据：{approvedDetail.evidence}</p>
                            <p>
                                观察于 {approvedDetail.observedAt} · 来源类型 {approvedDetail.sourceKind || "未标注"}
                            </p>
                            <a href={approvedDetail.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline dark:text-blue-300">
                                官网来源：{approvedDetail.sourceUrl}
                            </a>
                        </div>
                    </div>
                )}
            </Drawer>

            {audioContractPrice && (
                <AudioContractDrawer
                    key={`${modelId}:${audioContractPrice.id}`}
                    price={audioContractPrice}
                    logicalModelId={modelId}
                    onClose={() => {
                        setAudioContractPrice(null);
                        setModelDrawerOpen(true);
                        reloadActivationStatus();
                    }}
                />
            )}
            {videoContractPrice && (
                <VideoContractDrawer
                    key={`${modelId}:${videoContractPrice.id}`}
                    price={videoContractPrice}
                    logicalModelId={modelId}
                    onClose={() => {
                        setVideoContractPrice(null);
                        setModelDrawerOpen(true);
                        reloadActivationStatus();
                    }}
                />
            )}
            {imageContractPrice && (
                <ImageContractDrawer
                    key={`${modelId}:${imageContractPrice.id}`}
                    price={imageContractPrice}
                    logicalModelId={modelId}
                    onClose={() => {
                        setImageContractPrice(null);
                        setModelDrawerOpen(true);
                        reloadActivationStatus();
                    }}
                />
            )}
            {contractPrice && (
                <FlatTextContractDrawer
                    key={`${modelId}:${contractPrice.id}`}
                    price={contractPrice}
                    logicalModelId={modelId}
                    onClose={() => {
                        setContractPrice(null);
                        setModelDrawerOpen(true);
                        reloadActivationStatus();
                    }}
                />
            )}

            <Modal title="新渠道定向验收" open={Boolean(directedTest)} footer={null} onCancel={() => setDirectedTest(null)} destroyOnHidden>
                {directedTest && (
                    <div className="space-y-3 text-sm">
                        <p className="break-all">
                            渠道绑定：{directedTest.channelName} · {directedTest.bindingKey}。系统将锁定此绑定，沿用正常任务的协议和执行链路，不向其他渠道故障转移。
                        </p>
                        <p className="text-amber-700 dark:text-amber-300">这是真实上游调用，可能产生上游费用，并按管理员账号当前固定积分规则扣分。请使用无敏感内容的小额提示。</p>
                        {directedTest.capability === "image" && (
                            <Select
                                aria-label="验收图片操作"
                                className="w-full"
                                value={directedOperation}
                                options={[
                                    { value: "generation", label: "创建（generations）" },
                                    { value: "edit", label: "编辑（edits）" },
                                ]}
                                onChange={(value) => {
                                    setDirectedOperation(value);
                                    setDirectedReference("");
                                    setDirectedReferenceLabel("");
                                    setDirectedMentionOpen(false);
                                    setDirectedTask(null);
                                    setDirectedEvidence(null);
                                }}
                            />
                        )}
                        <Input.TextArea
                            aria-label="验收提示词"
                            rows={3}
                            value={directedPrompt}
                            onChange={(event) => {
                                setDirectedPrompt(event.target.value);
                                setDirectedMentionOpen(directedOperation === "edit" && event.target.value.endsWith("@"));
                            }}
                            placeholder={directedOperation === "edit" ? "填写编辑要求；输入 @ 可引用刚才创建的图片" : "填写可公开、低成本的测试提示"}
                        />
                        {directedTest.capability === "image" && directedOperation === "edit" && (
                            <div className="space-y-2">
                                {directedCreatedImages.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span>引用本次创建结果：</span>
                                        {directedCreatedImages.map((url, index) => (
                                            <Button
                                                key={`${index}-${url}`}
                                                size="small"
                                                type={directedReferenceLabel === `@图片${index + 1}` ? "primary" : "default"}
                                                onClick={() => {
                                                    setDirectedReference(url);
                                                    setDirectedReferenceLabel(`@图片${index + 1}`);
                                                    setDirectedPrompt((current) => (current.endsWith("@") ? current.slice(0, -1) : current));
                                                    setDirectedMentionOpen(false);
                                                }}
                                            >
                                                <Image src={url} alt={`创建结果图片 ${index + 1}`} width={20} height={20} preview={false} className="rounded object-cover" /> @图片{index + 1}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                                {directedMentionOpen && <p className="text-xs text-zinc-500">{directedCreatedImages.length ? "选择上方 @图片，作为编辑参考图" : "先完成创建验收并读取图片结果，或在下方上传参考图"}</p>}
                                <label className="block space-y-1">
                                    <span>编辑参考图{directedReferenceLabel ? ` · 已选择 ${directedReferenceLabel}` : ""}</span>
                                    <input
                                        aria-label="验收编辑参考图"
                                        type="file"
                                        accept="image/*"
                                        onChange={(event) => {
                                            const file = event.target.files?.[0];
                                            setDirectedReference("");
                                            setDirectedReferenceLabel("");
                                            if (!file) return;
                                            setDirectedMentionOpen(false);
                                            setDirectedPrompt((current) => (current.endsWith("@") ? current.slice(0, -1) : current));
                                            const reader = new FileReader();
                                            reader.onload = () => {
                                                setDirectedReference(typeof reader.result === "string" ? reader.result : "");
                                                setDirectedReferenceLabel(file.name);
                                            };
                                            reader.onerror = () => message.error("参考图读取失败");
                                            reader.readAsDataURL(file);
                                        }}
                                    />
                                </label>
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="primary"
                                loading={directedBusy}
                                disabled={!directedPrompt.trim() || (directedTest.capability === "image" && directedOperation === "edit" && (!directedReference || directedMentionOpen)) || Boolean(directedTask)}
                                onClick={() => void runDirectedTest()}
                            >
                                执行定向验收
                            </Button>
                            {directedTask && (
                                <Button loading={directedBusy} onClick={() => void refreshDirectedTask()}>
                                    读取任务结果
                                </Button>
                            )}
                        </div>
                        {directedTask && (
                            <p>
                                任务 {directedTask.id} · {directedTask.status}
                                {directedTask.executionPhase ? ` / ${directedTask.executionPhase}` : ""}
                                {directedTask.error ? ` · ${directedTask.error}` : ""}。影子报价只有在真实响应完整且匹配当前契约、售价时才计入准入。
                            </p>
                        )}
                        {directedEvidence && (
                            <div className="space-y-1 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                                <p>
                                    上游协议：{directedEvidence.protocol || "未识别"} · 路径：{directedEvidence.requestPath || "任务响应未保留路径"} · 操作：{directedEvidence.operation || directedTest.capability} · 渠道：{directedEvidence.channelId}
                                </p>
                                <p>
                                    请求型号：{directedEvidence.requestedModel} · 响应型号：{directedEvidence.reportedModel || "上游未报告"}
                                </p>
                                {directedEvidence.responseMeta && (
                                    <p>
                                        响应结束原因：{directedEvidence.responseMeta.stopReason} · 内容块类型：{directedEvidence.responseMeta.contentBlockTypes.join(" → ") || "无"} · 响应结束：
                                        {directedEvidence.responseMeta.terminalSeen ? "已确认" : "未确认"} · 内容块：{directedEvidence.responseMeta.blocksClosed ? "已结束" : "未结束"}
                                    </p>
                                )}
                                <p>
                                    本次影子报价：{directedEvidence.quotedPoints ? `${directedEvidence.quotedPoints} 积分` : "未形成可计价影子报价"} · {directedEvidence.status}
                                </p>
                                {Object.entries(directedEvidence.usageFields).map(([path, value]) => (
                                    <p key={path}>
                                        {path}：{value}
                                        {directedEvidence.zeroOnlyUsageFields.includes(path)
                                            ? " · 本次为零，不参与直接 Images 计价"
                                            : directedEvidence.unmappedUsageFields.includes(path)
                                              ? " · 含义待核对"
                                              : directedEvidence.protocol === "anthropic-messages" && (path === "cache_creation_input_tokens" || path.startsWith("iterations[") || path === "output_tokens_details.thinking_tokens")
                                                ? " · 仅校验，不重复计价"
                                                : directedEvidence.protocol === "anthropic-messages"
                                                  ? " · 已识别/用于报价"
                                                  : " · 已识别/用于校验"}
                                    </p>
                                ))}
                                {directedEvidence.reasons.map((reason, index) => (
                                    <p key={`${index}-${reason}`} className="text-amber-700 dark:text-amber-300">
                                        {reason}
                                    </p>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </Modal>

            <Drawer title={aiDiscoveryOnly ? "发现官网新型号" : "AI 核对官网价目"} width="min(880px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open={aiReviewOpen} onClose={() => setAiReviewOpen(false)}>
                <div className="space-y-4 text-sm">
                    <p className="text-zinc-600 dark:text-zinc-300">
                        选择厂商和已保存的官网价格链接。服务端浏览器读取页面实际显示的正文，再由后台默认文本模型整理。{aiDiscoveryOnly ? "已存在或已归档型号会跳过；新型号的核对结果自动保存为待确认发现。" : "核对结果需管理员确认。"}模型调用会产生费用。
                    </p>
                    {aiTargetOfficialModelId && <p className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">仅重新整理型号：{aiTargetOfficialModelId}</p>}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1">
                            <span className="text-xs text-zinc-500">模型厂商</span>
                            <div className="min-w-0">
                                <Select
                                    aria-label="核价模型厂商"
                                    className="w-full max-w-full"
                                    disabled={aiReviewRunning}
                                    showSearch
                                    optionFilterProp="label"
                                    placeholder="选择厂商"
                                    value={aiManufacturer || undefined}
                                    options={overview.officialSources.map((source) => ({ value: source.manufacturer, label: source.manufacturer }))}
                                    onChange={(value) => {
                                        setAiManufacturer(value);
                                        setAiTargetOfficialModelId("");
                                        setAiSourceUrl("");
                                        setAiSourceLinks([]);
                                        setAiReviewResult(undefined);
                                        setAiReviewProgress({});
                                        setAiReviewError("");
                                        setOfficialExcerpt("");
                                        setRetirementExcerpt("");
                                    }}
                                />
                            </div>
                        </div>
                        <div className="min-w-0 space-y-1">
                            <span className="text-xs text-zinc-500">官网价格链接</span>
                            <div className="min-w-0">
                                <Select
                                    aria-label="核价官网价格链接"
                                    className="w-full max-w-full"
                                    loading={aiSourceBusy}
                                    showSearch
                                    optionFilterProp="label"
                                    placeholder="选择官网链接"
                                    value={aiSourceUrl || undefined}
                                    disabled={!aiManufacturer || aiReviewRunning}
                                    options={aiSourceLinks.map((link) => ({ value: link.url, label: `${link.label} · ${link.url}` }))}
                                    onChange={(value) => {
                                        setAiSourceUrl(value);
                                        setAiReviewResult(undefined);
                                        setAiReviewProgress({});
                                        setAiReviewError("");
                                        setOfficialExcerpt("");
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                    {aiSourceUrl && (
                        <a className="block break-all text-blue-700 underline dark:text-blue-300" href={aiSourceUrl} target="_blank" rel="noreferrer">
                            查看所选官网链接：{aiSourceUrl}
                        </a>
                    )}
                    <label className="block space-y-1">
                        官网价目摘录（浏览器无法读取时填写）
                        <Input.TextArea
                            aria-label="官网价目摘录"
                            disabled={aiReviewRunning}
                            value={officialExcerpt}
                            onChange={(event) => setOfficialExcerpt(event.target.value)}
                            autoSize={{ minRows: 3, maxRows: 9 }}
                            placeholder="从所选官网价格页复制相关模型的价格表，保留型号、币种、单位及适用条件"
                        />
                    </label>
                    {bytePlusReview && (
                        <label className="block space-y-1">
                            BytePlus 停用公告摘录（可选）
                            <Input.TextArea
                                aria-label="官网停用公告摘录"
                                disabled={aiReviewRunning}
                                value={retirementExcerpt}
                                onChange={(event) => setRetirementExcerpt(event.target.value)}
                                autoSize={{ minRows: 2, maxRows: 6 }}
                                placeholder="若要确认下架，请从 BytePlus 官方停用公告复制含型号及日期的段落"
                            />
                        </label>
                    )}
                    <Button type="primary" loading={aiReviewBusy} disabled={!aiSourceUrl || aiSourceBusy} onClick={() => void runAiReview()}>
                        {aiDiscoveryOnly ? "扫描并归档新型号" : "读取官网并开始核对"}
                    </Button>
                    {(aiReviewRunning || Object.keys(aiReviewProgress).length > 0 || aiReviewError) && (
                        <div role="status" aria-live="polite" className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="flex items-center justify-between gap-2">
                                <b>核对进度</b>
                                {aiReviewRunning && <span className="text-xs text-zinc-500">已用 {aiReviewElapsed} 秒</span>}
                            </div>
                            {reviewStages.map((stage) => {
                                const current = aiReviewProgress[stage.id];
                                const status = current?.status || "pending";
                                return (
                                    <div key={stage.id} className="flex min-w-0 items-start gap-2 text-xs">
                                        <Tag color={status === "done" ? "green" : status === "active" ? "blue" : status === "warning" ? "gold" : status === "failed" ? "red" : "default"}>
                                            {{ pending: "待开始", active: "进行中", done: "已完成", warning: "需注意", skipped: "已跳过", failed: "失败" }[status]}
                                        </Tag>
                                        <span className="min-w-0 break-words">
                                            <b>{stage.label}</b>
                                            {current?.detail && <span className="ml-2 text-zinc-600 dark:text-zinc-300">{current.detail}</span>}
                                        </span>
                                    </div>
                                );
                            })}
                            {aiReviewError && <p className="text-xs text-red-700 dark:text-red-300">{aiReviewError}</p>}
                        </div>
                    )}
                    {aiReviewResult && (
                        <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                            <p className="text-xs text-zinc-500">
                                来源：{aiReviewResult.sourceMode === "website" ? "网站正文" : "管理员粘贴的官网摘录"} · 核对于 {new Date(aiReviewResult.observedAt).toLocaleString("zh-CN")} · 摘要 {aiReviewResult.sourceDigest.slice(0, 12)}
                            </p>
                            {aiDiscoveryOnly && (
                                <p className="text-xs text-zinc-500">
                                    跳过已有型号 {aiReviewResult.skippedExistingModelIds?.length || 0} 个 · 发现新增 {aiReviewResult.sourceOfficialModelIds.length} 个 · 尚未核对{" "}
                                    {aiReviewResult.missingOfficialModelIds.length + (aiReviewResult.uncertainModelIds?.length || 0)} 个
                                </p>
                            )}
                            {aiReviewResult.warnings.map((warning) => (
                                <p key={warning} className="text-amber-700 dark:text-amber-300">
                                    {warning}
                                </p>
                            ))}
                            {aiReviewResult.findings.map((finding, index) => (
                                <div key={`${finding.officialModelId}-${index}`} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <b className="break-all">{finding.officialModelId}</b>
                                        <Tag color={finding.status === "confirmed-retired" ? "red" : finding.status === "new" || finding.status === "changed" ? "blue" : finding.status === "unchanged" ? "green" : "gold"}>
                                            {
                                                { new: "新价目", changed: "价格变化", unchanged: "未变化", unmatched: "未匹配平台模型", "needs-review": "需人工核实", "retirement-announced": "已公告将停用", "confirmed-retired": "停用日期已过" }[
                                                    finding.status
                                                ]
                                            }
                                        </Tag>
                                    </div>
                                    {finding.sourceRowIds.length > 0 && <p className="text-xs text-zinc-500">官网价格行：{finding.sourceRowIds.join("、")}</p>}
                                    <p className="text-xs text-zinc-500">
                                        平台模型：{finding.logicalModelId || "未确认映射"}
                                        {finding.currentPriceId ? ` · 当前官方版本 ${finding.currentPriceId}` : ""}
                                    </p>
                                    <p>
                                        {finding.reason}
                                        {finding.deactivationDate ? ` · 公告停用日期 ${finding.deactivationDate}` : ""}
                                    </p>
                                    <blockquote className="break-words border-l-2 border-zinc-300 pl-3 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">{finding.evidence}</blockquote>
                                    {finding.currentItems.length > 0 && (
                                        <div className="space-y-1 text-xs text-zinc-500">
                                            <b>平台现有已审核价目</b>
                                            {finding.currentItems.map((item) => (
                                                <p key={item.key}>
                                                    {item.key}：{item.price} {item.currency} / {item.per} {item.unit}
                                                </p>
                                            ))}
                                            {finding.currentConditions && <p>适用条件：{finding.currentConditions}</p>}
                                        </div>
                                    )}
                                    {finding.pendingCandidateId && <p className="text-xs text-amber-700 dark:text-amber-300">已有待审核候选 {finding.pendingCandidateId}，请先处理现有候选。</p>}
                                    {finding.extractionIssue && <p className="text-xs text-amber-700 dark:text-amber-300">价目整理待核对：{finding.extractionIssue}</p>}
                                    {aiDiscoveryOnly && aiReviewResult.findings.some((other) => other !== finding && other.officialModelId.toLowerCase() === finding.officialModelId.toLowerCase()) && (
                                        <p className="text-xs text-amber-700 dark:text-amber-300">该型号有多条价格证据，需完整合并核对后归档。</p>
                                    )}
                                    {finding.observedItems.length > 0 && (
                                        <div className="space-y-1 text-xs">
                                            {finding.observedItems.map((item) => (
                                                <p key={item.key}>
                                                    {item.key}：{item.price} {item.currency} / {item.per} {item.unit}
                                                    {item.condition ? ` · ${item.condition}` : ""}
                                                </p>
                                            ))}
                                            <p>适用条件：{finding.observedConditions || "待补齐"}</p>
                                        </div>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                        {!aiDiscoveryOnly && finding.observedItems.length > 0 && !finding.pendingCandidateId && (
                                            <Button size="small" onClick={() => openAiPriceDraft(finding)}>
                                                核对并录入价目
                                            </Button>
                                        )}
                                        {finding.status !== "confirmed-retired" && finding.status !== "retirement-announced" && canReview && (
                                            <Button
                                                size="small"
                                                disabled={
                                                    aiReviewBusy ||
                                                    savedFindingKeys.includes(`${finding.officialModelId}:${finding.evidence}`) ||
                                                    (aiDiscoveryOnly && aiReviewResult.findings.some((other) => other !== finding && other.officialModelId.toLowerCase() === finding.officialModelId.toLowerCase()))
                                                }
                                                onClick={() => void archiveFinding(finding)}
                                            >
                                                {savedFindingKeys.includes(`${finding.officialModelId}:${finding.evidence}`) ? "已归档" : "保存官网发现"}
                                            </Button>
                                        )}
                                        {finding.status === "confirmed-retired" &&
                                            finding.logicalModelId &&
                                            aiReviewResult.manufacturer === "ByteDance / Volcengine" &&
                                            /seedream|(?:^|[-_])seed(?:[-_\d]|$)/i.test(`${finding.logicalModelId} ${overview.models.find((model) => model.id === finding.logicalModelId)?.name || ""}`) &&
                                            !/seedance/i.test(finding.logicalModelId) &&
                                            canReview && (
                                                <Button size="small" disabled={aiReviewBusy} onClick={() => void setRetired(finding, overview.lifecycleMarks.some((mark) => mark.logicalModelId === finding.logicalModelId) ? "unmark" : "mark")}>
                                                    {overview.lifecycleMarks.some((mark) => mark.logicalModelId === finding.logicalModelId) ? "撤销停用标记" : "确认标记停用"}
                                                </Button>
                                            )}
                                        {finding.status === "confirmed-retired" && finding.logicalModelId && canPublish && policy.priceVersionIds[finding.logicalModelId] && (
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    const next = { ...policy.priceVersionIds };
                                                    delete next[finding.logicalModelId!];
                                                    updatePolicy({ ...policy, priceVersionIds: next });
                                                    setModelId(Object.keys(next)[0] || "");
                                                    message.info("已从售价草稿移除；请在销售策略区预览并发布新版本");
                                                }}
                                            >
                                                从新售价草稿移除
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Drawer>

            {canReview && activeGroup === "official" && officialSub === "discovery" && (
                <section className={section}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h2 className="font-semibold">官网模型发现档案</h2>
                            <p className="mt-1 text-xs text-zinc-500">选择厂商和官网来源扫描新型号；已存在型号跳过。确认后进入待审价目，删除后可再次发现。</p>
                        </div>
                        <Button
                            type="primary"
                            onClick={() => {
                                setAiDiscoveryOnly(true);
                                setAiManufacturer(observationManufacturer);
                                setAiSourceUrl("");
                                setAiTargetOfficialModelId("");
                                setAiReviewResult(undefined);
                                setAiReviewOpen(true);
                            }}
                        >
                            发现官网新型号
                        </Button>
                        <Select
                            aria-label="官网发现厂商筛选"
                            className="w-full sm:w-64"
                            allowClear
                            placeholder="全部厂商"
                            value={observationManufacturer || undefined}
                            options={overview.officialSources.map((item) => ({ value: item.manufacturer, label: item.manufacturer }))}
                            onChange={(value) => {
                                const manufacturer = value || "";
                                setObservationManufacturer(manufacturer);
                                void loadObservations(1, manufacturer).catch(showError);
                            }}
                        />
                    </div>
                    <div className="space-y-2">
                        {observationPage?.observations.map((item) => {
                            const variants = officialPriceObservationVariants(item);
                            return (
                                <div key={item.id} data-testid="official-observation-card" className="min-w-0 space-y-3 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800 sm:p-4">
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                            <b className="min-w-0 break-all leading-5">{item.officialModelId}</b>
                                            <Tag color="gold">待确认</Tag>
                                        </div>
                                        <p className="break-words text-xs leading-5 text-zinc-500">
                                            {item.manufacturer} · {variants.reduce((count, variant) => count + variant.items.length, 0) ? `${variants.reduce((count, variant) => count + variant.items.length, 0)} 项价格` : "仅确认型号"}
                                        </p>
                                    </div>
                                    <details className="min-w-0 text-xs text-zinc-600 dark:text-zinc-300">
                                        <summary className="cursor-pointer text-blue-700 dark:text-blue-300">查看官网价格与原文证据</summary>
                                        <div className="mt-3 min-w-0 space-y-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
                                            {variants.map((variant, index) => (
                                                <div key={index}>
                                                    <b className="text-zinc-700 dark:text-zinc-200">
                                                        价格组 {index + 1} · {variant.amendment ? `人工修订第 ${variant.amendment.revision} 版` : "AI 提取"}
                                                    </b>
                                                    <div className="mt-1 grid gap-1 sm:grid-cols-2">
                                                        {variant.items.map((price) => (
                                                            <p key={price.key} className="min-w-0 break-all leading-5">
                                                                {price.key}：{displayPrice(price)}
                                                            </p>
                                                        ))}
                                                    </div>
                                                    {variant.conditions && <p className="mt-1 break-words leading-5">适用条件：{variant.conditions}</p>}
                                                </div>
                                            ))}
                                            <div>
                                                <b className="text-zinc-700 dark:text-zinc-200">官网原文证据</b>
                                                <p data-testid="official-observation-evidence" className="mt-1 whitespace-pre-wrap break-all leading-5">
                                                    {item.evidence}
                                                </p>
                                            </div>
                                            <div className="space-y-1 border-t border-zinc-200 pt-2 text-zinc-500 dark:border-zinc-800">
                                                <p className="break-all">官网价格行：{item.sourceRowIds.join("、") || "未提取行号"}</p>
                                                <p>核对时间：{item.observedAt}</p>
                                                <p className="break-all">正文 SHA-256：{item.sourceDigest}</p>
                                                <a className="inline-block text-blue-700 dark:text-blue-300" href={item.sourceUrl} target="_blank" rel="noreferrer">
                                                    查看官网来源
                                                </a>
                                            </div>
                                            {item.amendments?.length ? (
                                                <details>
                                                    <summary className="cursor-pointer">查看人工修订记录（{item.amendments.length} 次）</summary>
                                                    <div className="mt-1 space-y-1">
                                                        {item.amendments.map((amendment) => (
                                                            <p key={amendment.revision}>
                                                                第 {amendment.revision} 版 · 价格组 {amendment.variantIndex + 1} · {amendment.editedAt} · {amendment.reason}
                                                            </p>
                                                        ))}
                                                    </div>
                                                </details>
                                            ) : null}
                                        </div>
                                    </details>
                                    {variants.some((variant) => variant.items.length > 0 && !variant.conditions) && <p className="text-xs text-amber-700 dark:text-amber-300">适用条件尚未核实，录入价目候选前需补齐。</p>}
                                    {item.extractionIssue && <p className="text-xs text-amber-700 dark:text-amber-300">价目整理待核对：{item.extractionIssue}</p>}
                                    {canReview && (
                                        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    setAiManufacturer(item.manufacturer);
                                                    setAiSourceUrl(item.sourceUrl);
                                                    setAiTargetOfficialModelId(item.officialModelId);
                                                    setAiDiscoveryOnly(false);
                                                    setAiReviewResult(undefined);
                                                    setAiReviewOpen(true);
                                                }}
                                            >
                                                AI 重新整理此型号
                                            </Button>
                                            {item.reviewStatus === "pending" && (
                                                <>
                                                    {variants.map((_, index) => (
                                                        <Button key={index} size="small" onClick={() => openObservationCorrection(item, index)}>
                                                            修订价格组 {index + 1}
                                                        </Button>
                                                    ))}
                                                    <Button size="small" onClick={() => reviewObservation(item.id)}>
                                                        确认证据
                                                    </Button>
                                                    <Button size="small" danger onClick={() => deleteObservation(item.id)}>
                                                        删除发现
                                                    </Button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {observationPage?.total === 0 && <Empty description="暂无官网发现档案" />}
                    </div>
                    {observationPage && observationPage.total > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            <span>共 {observationPage.total} 条</span>
                            {pager(observationPage.page, observationPage.total, observationPage.pageSize, (page) => void loadObservations(page).catch(showError))}
                        </div>
                    )}
                </section>
            )}

            <Drawer
                title={modelId ? `${overview.models.find((item) => item.id === modelId)?.name || modelId} · 模型售价与渠道` : "模型售价与渠道"}
                width="min(980px, 100vw)"
                styles={{ wrapper: { maxWidth: "100vw" } }}
                open={modelDrawerOpen}
                onClose={() => setModelDrawerOpen(false)}
                afterOpenChange={(open) => {
                    if (open || !pendingContract) return;
                    if (pendingContract.kind === "text") setContractPrice(pendingContract.price);
                    if (pendingContract.kind === "image") setImageContractPrice(pendingContract.price);
                    if (pendingContract.kind === "video") setVideoContractPrice(pendingContract.price);
                    if (pendingContract.kind === "audio") setAudioContractPrice(pendingContract.price);
                    setPendingContract(null);
                }}
            >
                <section className={section}>
                    <div className="mb-4">
                        <h2 className="font-semibold">销售策略与样例报价</h2>
                        <p className="mt-1 text-xs text-zinc-500">当前发布版本：{overview.currentSalesVersionId || "尚未发布"}。倍率按具体逻辑模型保存，未设置显示默认 1；套餐规则只取最具体的一项。</p>
                    </div>
                    <nav aria-label="模型详情层级" className="mb-4 flex flex-wrap gap-2">
                        {(
                            [
                                ["overview", "模型概况"],
                                ["conditions", "该模型计价条件"],
                                ["bindings", "渠道绑定"],
                            ] as const
                        ).map(([key, label]) => (
                            <Button key={key} type={modelDetailView === key ? "primary" : "default"} onClick={() => setModelDetailView(key)}>
                                {label}
                            </Button>
                        ))}
                    </nav>
                    {modelDetailView === "overview" && (
                        <div className="space-y-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                            <div className="grid gap-2 sm:grid-cols-4">
                                {[
                                    { label: "1 官方价", ready: Boolean(modelVersions.length || publishedSelections.length) },
                                    { label: "2 售价发布", ready: Boolean(publishedPolicy?.priceVersionIds[modelId] || publishedSelections.length) },
                                    { label: "3 渠道验收", ready: Boolean(activationStatus?.bindings.some((binding) => binding.fingerprint && binding.shadow?.ready)) },
                                    { label: "4 按量运行", ready: Boolean(activationStatus?.active && overview.models.find((item) => item.id === modelId)?.enabled) },
                                ].map((step) => (
                                    <div
                                        key={step.label}
                                        className={`rounded-lg border p-2 text-xs ${step.ready ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200" : "border-zinc-200 text-zinc-500 dark:border-zinc-800"}`}
                                    >
                                        {step.ready ? "✓ " : "待完成 · "}
                                        {step.label}
                                    </div>
                                ))}
                            </div>
                            <p>
                                <b>逻辑模型：</b>
                                {modelId} · {overview.models.find((item) => item.id === modelId)?.enabled ? "已启用" : "已关闭"}
                            </p>
                            <p>
                                <b>官方价：</b>
                                {modelVersions.length || publishedSelections.length ? `${modelVersions.length} 个旧式关联版本；${publishedSelections.length} 个独立选价范围` : "未找到当前模型的已审核价目"}
                            </p>
                            <p>
                                <b>用户售价：</b>
                                {publishedPolicy?.priceVersionIds[modelId] || publishedSelections.length ? "已发布" : "未发布"}
                                {draftSaleChanged ? " · 草稿有变更" : ""}
                            </p>
                            <p>
                                <b>实际计费：</b>
                                {overview.models.find((item) => item.id === modelId)?.enabled === false
                                    ? "已关闭，不承接新请求"
                                    : activationStatus?.admission.modelId !== modelId
                                      ? "读取中"
                                      : activationStatus.active
                                        ? "按量扣分"
                                        : activationStatus.activation?.enabled
                                          ? "按量暂停，待核对"
                                          : "固定积分"}
                            </p>
                            <p className="text-amber-700 dark:text-amber-300">{activationStatus?.admission.blockers[0] || "进入计价条件与渠道绑定查看完整验收状态"}</p>
                            <div>
                                {!modelVersions.length && !publishedSelections.length && canReview ? (
                                    <Button
                                        data-testid="pricing-primary-action"
                                        onClick={() => {
                                            setModelDrawerOpen(false);
                                            openCandidate(modelId);
                                            setActiveGroup("official");
                                            setOfficialSub("pending");
                                        }}
                                    >
                                        录入官方价目
                                    </Button>
                                ) : (
                                    <Button data-testid="pricing-primary-action" onClick={() => setModelDetailView(!publishedPolicy?.priceVersionIds[modelId] || publishedSelections.length || activationStatus?.active ? "conditions" : "bindings")}>
                                        {!publishedPolicy?.priceVersionIds[modelId] && !publishedSelections.length ? "配置用户售价" : activationStatus?.active ? "查看计价条件" : "核对渠道绑定"}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                    {modelDetailView === "conditions" && (
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <label className={field}>
                                逻辑模型
                                <div>
                                    <Cascader
                                        aria-label="售价逻辑模型"
                                        className="w-full"
                                        value={modelPath(modelId)}
                                        options={modelTree}
                                        placeholder="依次选择厂商 / 能力 / 模型"
                                        showSearch
                                        displayRender={(labels) => labels.at(-1)}
                                        onChange={(path) => {
                                            const value = String(path[2] || "");
                                            if (!value) return;
                                            setModelId(value);
                                            setUsage({});
                                            setPreview(undefined);
                                            void loadOverview(value, overview.candidatePage, 1, candidateFilter).catch(showError);
                                        }}
                                    />
                                </div>
                            </label>
                            <label className={field}>
                                已审核官方价版本
                                <div>
                                    <Select
                                        aria-label="已审核官方价版本"
                                        className="w-full"
                                        allowClear
                                        value={policy.priceVersionIds[modelId]}
                                        placeholder="选择版本"
                                        options={modelVersions.map((item) => ({
                                            value: item.id,
                                            label: `${item.sku} · ${item.tier === "free" ? "免费" : "付费"}${processingTierLabel(item) ? ` · ${processingTierLabel(item)}` : ""} · ${item.effectiveFrom?.slice(0, 10) || "当前有效"}`,
                                        }))}
                                        disabled={!canPublish}
                                        onChange={(value) => {
                                            const priceVersionIds = { ...policy.priceVersionIds };
                                            if (value) priceVersionIds[modelId] = value;
                                            else delete priceVersionIds[modelId];
                                            const selectedVersion = modelVersions.find((item) => item.id === value);
                                            updatePolicy({
                                                ...policy,
                                                priceVersionIds,
                                                deepSeekUtcWindowModels: selectedVersion && supportsDeepSeekTimePricing(selectedVersion) ? policy.deepSeekUtcWindowModels : (policy.deepSeekUtcWindowModels || []).filter((id) => id !== modelId),
                                            });
                                            setUsage({});
                                        }}
                                    />
                                </div>
                            </label>
                            {overview.officialTotal > overview.pageSize && (
                                <div className="flex items-center gap-2 text-xs">
                                    <span>版本第 {overview.officialPage} 页</span>
                                    <Button size="small" disabled={overview.officialPage <= 1} onClick={() => void refresh(overview.candidatePage, overview.officialPage - 1)}>
                                        上一页
                                    </Button>
                                    <Button size="small" disabled={overview.officialPage * overview.pageSize >= overview.officialTotal} onClick={() => void refresh(overview.candidatePage, overview.officialPage + 1)}>
                                        下一页
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                    {modelDetailView === "conditions" && (
                        <section className="mt-4 space-y-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                            <div>
                                <h3 className="font-semibold">独立官网价选价</h3>
                                <p className="mt-1 text-xs text-zinc-500">
                                    先按操作绑定已审核的国际站 USD 价，再加入售价草稿、预览并发布；发布不会自动启用按量扣分。逻辑模型名与官网 SKU 不同时，须在审核依据中写明精确型号关系；渠道请求名另在计量契约中审核。
                                </p>
                                {!modelManufacturer && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">请先为逻辑模型配置厂商，再选择该厂商的官网价。</p>}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <label className={field}>
                                    收费操作
                                    <Select
                                        aria-label="独立选价操作"
                                        value={selectionOperation}
                                        options={selectionOperations.map((operation) => ({
                                            value: operation,
                                            label: operation === "generations" ? "图片生成" : operation === "edits" ? "图片编辑" : operation === "generateContent" ? "Gemini 音频生成" : operation === "chat/completions" ? "OpenAI 原生音频" : "生成",
                                        }))}
                                        onChange={(value) => {
                                            setSelectionOperation(value);
                                            setActivationStatus(undefined);
                                            setUsage({});
                                            setPreview(undefined);
                                            setSelectionBinding(null);
                                            setSelectionVersionId("");
                                        }}
                                    />
                                </label>
                                <label className={field}>
                                    官网 SKU 搜索
                                    <div className="flex gap-2">
                                        <Input
                                            aria-label="独立官网 SKU 搜索"
                                            value={selectionQuery}
                                            onChange={(event) => setSelectionQuery(event.target.value)}
                                            onPressEnter={() => {
                                                setSelectionPage(1);
                                                setSelectionSearch(selectionQuery.trim());
                                            }}
                                        />
                                        <Button
                                            onClick={() => {
                                                setSelectionPage(1);
                                                setSelectionSearch(selectionQuery.trim());
                                            }}
                                        >
                                            搜索
                                        </Button>
                                    </div>
                                </label>
                                <label className={field}>
                                    已审核独立官网价
                                    <Select
                                        aria-label="独立官网价版本"
                                        value={selectionVersionId || undefined}
                                        placeholder="选择可用的 Standard USD 价"
                                        options={[
                                            ...(selectionOptions?.items.map((item) => ({
                                                value: item.version.id,
                                                label: `${item.version.sku} · ${item.version.officialVersion}${item.selectable ? "" : ` · ${item.issues.join("；")}`}`,
                                                disabled: !item.selectable,
                                            })) || []),
                                            ...(selectionVersionId && !selectionOptions?.items.some((item) => item.version.id === selectionVersionId) ? [{ value: selectionVersionId, label: `${selectionVersionId} · 当前绑定`, disabled: true }] : []),
                                        ]}
                                        disabled={!(canReview || canPublish)}
                                        onChange={(value) => {
                                            setSelectionVersionId(value);
                                            setUsage({});
                                            setPreview(undefined);
                                        }}
                                    />
                                </label>
                                <label className={field}>
                                    选价审核依据
                                    <Input aria-label="独立选价审核依据" value={selectionEvidence} disabled={!canReview} onChange={(event) => setSelectionEvidence(event.target.value)} placeholder="精确 SKU、国际区及官方来源核对结论" />
                                </label>
                            </div>
                            {selectionOptions && selectionOptions.total > selectionOptions.pageSize && (
                                <div className="flex items-center gap-2 text-xs text-zinc-500">
                                    <Button size="small" disabled={selectionPage <= 1} onClick={() => setSelectionPage((page) => page - 1)}>
                                        上一页
                                    </Button>
                                    <span>
                                        {selectionPage} / {Math.ceil(selectionOptions.total / selectionOptions.pageSize)}
                                    </span>
                                    <Button size="small" disabled={selectionPage * selectionOptions.pageSize >= selectionOptions.total} onClick={() => setSelectionPage((page) => page + 1)}>
                                        下一页
                                    </Button>
                                </div>
                            )}
                            <p className="text-xs text-zinc-500">
                                当前绑定：{selectionBinding?.status === "active" ? `${selectionBinding.officialVersionId} · revision ${selectionBinding.revision}` : selectionBinding?.status === "revoked" ? "已解除" : "无"}；已发布售价：
                                {publishedSelections.some((item) => item.scope === selectionScope) ? "该范围已引用" : "该范围未引用"}。
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {canReview && (
                                    <Button
                                        loading={selectionBusy}
                                        disabled={!selectionVersionId || !selectionEvidence.trim() || !selectionOptions?.items.some((item) => item.version.id === selectionVersionId && item.selectable)}
                                        onClick={() => void bindIndependentPrice()}
                                    >
                                        保存独立选价
                                    </Button>
                                )}
                                {canPublish && (
                                    <Button
                                        disabled={selectionBinding?.status !== "active" || !selectionBinding.officialVersionId || (selectedReference?.bindingId === selectionBinding.id && selectedReference.bindingRevision === selectionBinding.revision)}
                                        onClick={() => selectionBinding && adoptIndependentBinding(selectionBinding)}
                                    >
                                        加入售价草稿
                                    </Button>
                                )}
                                {canReview && (
                                    <Button disabled={selectionBinding?.status !== "active" || !selectionEvidence.trim()} onClick={revokeIndependentPrice}>
                                        解除选价绑定
                                    </Button>
                                )}
                                {canPublish && (
                                    <Button disabled={!publishedSelections.some((item) => item.scope === selectionScope)} onClick={unbindPublishedSelection}>
                                        取消该范围已发布售价
                                    </Button>
                                )}
                                {canPublish &&
                                    priceContractKind &&
                                    independentPrice &&
                                    (independentPrice.items.length > 0 || (priceContractKind === "text" && Boolean(independentPrice.textPriceSchedule))) &&
                                    selectionBinding?.status === "active" &&
                                    selectionBinding.officialVersionId === independentPrice.id && (
                                        <Button
                                            onClick={() => {
                                                setPendingContract({ kind: priceContractKind, price: independentPrice });
                                                setModelDrawerOpen(false);
                                            }}
                                        >
                                            核对{({ text: "文本", image: "图片", video: "视频", audio: "音频" } as const)[priceContractKind]}用量契约
                                        </Button>
                                    )}
                            </div>
                            {selectedReference && independentPrice && (
                                <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                                    <p className="text-xs">
                                        售价草稿：{independentPrice.manufacturer} / {independentPrice.sku} · {selectionScope}
                                        {independentPrice.textPriceSchedule
                                            ? ` · ${independentPrice.textPriceSchedule.groups.filter((group) => group.selector.processingMode === "standard").length} 个 Standard 价格组`
                                            : ` · ${independentPrice.items.length} 个分项`}
                                    </p>
                                    <label className={`${field} max-w-xs`}>
                                        该模型用户售价系数
                                        <Input
                                            aria-label="独立选价用户售价系数"
                                            value={policy.userPriceRules.find((rule) => rule.scope === "model" && rule.modelId === modelId)?.coefficient || ""}
                                            placeholder="继承默认规则"
                                            disabled={!canPublish}
                                            onChange={(event) => {
                                                const rules = policy.userPriceRules.filter((rule) => !(rule.scope === "model" && rule.modelId === modelId));
                                                updatePolicy({ ...policy, userPriceRules: event.target.value ? [...rules, { scope: "model", modelId, coefficient: event.target.value }] : rules });
                                            }}
                                        />
                                    </label>
                                    {supportsDeepSeekTimePricing(independentPrice) && (
                                        <div className="space-y-1">
                                            <Checkbox
                                                checked={policy.deepSeekUtcWindowModels?.includes(modelId) === true}
                                                disabled={!canPublish}
                                                onChange={(event) =>
                                                    updatePolicy({
                                                        ...policy,
                                                        deepSeekUtcWindowModels: event.target.checked ? [...new Set([...(policy.deepSeekUtcWindowModels || []), modelId])] : (policy.deepSeekUtcWindowModels || []).filter((id) => id !== modelId),
                                                    })
                                                }
                                            >
                                                按 UTC 工作日时窗切换高峰／离峰售价
                                            </Checkbox>
                                            <p className="text-xs text-zinc-500">关闭时全天按高峰价；开启时周一至周五 UTC 01:00–04:00、06:00–10:00 按高峰价，其余按离峰价。这是平台售价规则，并非上游实际账单。</p>
                                        </div>
                                    )}
                                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                        {independentPrice.textPriceSchedule && (
                                            <label className={field}>
                                                输入总 Token（整次请求选档）
                                                <Input
                                                    aria-label="样例输入总 Token"
                                                    value={usage.inputTotalTokens || ""}
                                                    onChange={(event) => {
                                                        setUsage((current) => ({ ...current, inputTotalTokens: event.target.value }));
                                                        setPreview(undefined);
                                                    }}
                                                />
                                            </label>
                                        )}
                                        {(
                                            independentPrice.textPriceSchedule?.meters.map((item) => item.meter) ||
                                            independentPrice.items.map((item) => item.key).filter((key) => !supportsDeepSeekTimePricing(independentPrice) || DEEPSEEK_TIME_PRICE_KEYS.peak.includes(key as (typeof DEEPSEEK_TIME_PRICE_KEYS.peak)[number]))
                                        ).map((meter) => (
                                            <label key={meter} className={field}>
                                                {meter} 样例用量
                                                <Input
                                                    aria-label={`样例用量 ${meter}`}
                                                    value={usage[meter] || ""}
                                                    onChange={(event) => {
                                                        setUsage((current) => ({ ...current, [meter]: event.target.value }));
                                                        setPreview(undefined);
                                                    }}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button loading={busy} disabled={!canPublish} onClick={() => void runPreview()}>
                                            按样例用量预览
                                        </Button>
                                        <Button type="primary" disabled={!canPublish || !preview || preview.selectedBinding?.scope !== selectionScope} onClick={publish}>
                                            发布销售版本
                                        </Button>
                                    </div>
                                    {preview?.selectedBinding?.scope === selectionScope && (
                                        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/25">
                                            样例应收 {preview.quote.points} 积分 · 选中价格组 {preview.selectedGroupId || "平价"} · 仅预览，不改变当前扣分方式
                                            {preview.deepSeekTier && (
                                                <p className="mt-1">
                                                    本次预览：{preview.deepSeekTier === "peak" ? "高峰价" : "离峰价"} · UTC {preview.pricingAt}；实际请求按开始预留时的 UTC 时间冻结价档。
                                                </p>
                                            )}
                                            <div className="mt-2 space-y-1">
                                                {preview.quote.lines.map((line) => (
                                                    <p key={line.key}>
                                                        {line.key}：{line.quantity} {line.unit} × {line.price} {line.currency} / {line.per} = {line.officialAmount} {line.currency}
                                                    </p>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </section>
                    )}
                    {modelDetailView !== "overview" && !selectedPrice && !selectedReference && activationStatus?.admission.modelId === modelId && (
                        <div data-testid="model-billing-status" className="mt-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                            <b>{modelId} · 当前收费：固定积分</b>
                            <p className="mt-2 text-amber-700 dark:text-amber-300">{activationStatus.admission.blockers[0] || "请先选择并发布该模型的官方价与售价"}</p>
                        </div>
                    )}
                    {selectedPrice && modelDetailView === "conditions" && (
                        <div className="mt-4 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                            <b>官方价：</b>
                            {selectedPrice.manufacturer} / {linkedCatalogNames(selectedPrice) || `${selectedPrice.series} / ${selectedPrice.officialVersion}`} / SKU {selectedPrice.sku} ·{" "}
                            {processingTierLabel(selectedPrice) && `${processingTierLabel(selectedPrice)} · `}
                            {selectedPrice.conditions}
                            <div className="mt-1 text-zinc-500">
                                {selectedPrice.tier === "free" ? "免费档" : "付费档"} · 生效：{selectedPrice.effectiveFrom || "未限定"} 至 {selectedPrice.effectiveTo || "未限定"}
                            </div>
                            <label className={`${field} mt-3 max-w-xs`}>
                                该模型用户售价系数
                                <Input
                                    aria-label="该模型用户售价系数"
                                    value={policy.userPriceRules.find((rule) => rule.scope === "model" && rule.modelId === modelId)?.coefficient || ""}
                                    placeholder={`继承 ${resolveUserPriceCoefficient(selectedPrice, policy).value}`}
                                    disabled={!canPublish}
                                    onChange={(event) => {
                                        const rules = policy.userPriceRules.filter((rule) => !(rule.scope === "model" && rule.modelId === modelId));
                                        updatePolicy({ ...policy, userPriceRules: event.target.value ? [...rules, { scope: "model", modelId, coefficient: event.target.value }] : rules });
                                    }}
                                />
                            </label>
                            {supportsDeepSeekTimePricing(selectedPrice) && (
                                <div className="mt-3 space-y-1">
                                    <Checkbox
                                        checked={policy.deepSeekUtcWindowModels?.includes(modelId) === true}
                                        disabled={!canPublish}
                                        onChange={(event) =>
                                            updatePolicy({
                                                ...policy,
                                                deepSeekUtcWindowModels: event.target.checked ? [...new Set([...(policy.deepSeekUtcWindowModels || []), modelId])] : (policy.deepSeekUtcWindowModels || []).filter((id) => id !== modelId),
                                            })
                                        }
                                    >
                                        按 UTC 工作日时窗切换高峰／离峰售价
                                    </Checkbox>
                                    <p className="text-zinc-500">关闭时全天按高峰价；开启时周一至周五 UTC 01:00–04:00、06:00–10:00 按高峰价，其余按离峰价。不判断中国法定节假日，这是平台售价规则，并非上游实际账单。</p>
                                </div>
                            )}
                            {canPublish && selectedPrice.tier === "paid" && overview.models.find((item) => item.id === modelId)?.capability === "text" && (
                                <Button
                                    className="mt-2"
                                    size="small"
                                    onClick={() => {
                                        setPendingContract({ kind: "text", price: selectedPrice });
                                        setModelDrawerOpen(false);
                                    }}
                                >
                                    核对文本用量契约
                                </Button>
                            )}
                            {canPublish && needsContractReview && selectedPrice.tier === "paid" && overview.models.find((item) => item.id === modelId)?.capability === "video" && (
                                <Button
                                    className="mt-2"
                                    size="small"
                                    onClick={() => {
                                        setPendingContract({ kind: "video", price: selectedPrice });
                                        setModelDrawerOpen(false);
                                    }}
                                >
                                    核对视频用量契约
                                </Button>
                            )}
                            {canPublish && needsContractReview && selectedPrice.tier === "paid" && overview.models.find((item) => item.id === modelId)?.capability === "audio" && (
                                <Button
                                    className="mt-2"
                                    size="small"
                                    onClick={() => {
                                        setPendingContract({ kind: "audio", price: selectedPrice });
                                        setModelDrawerOpen(false);
                                    }}
                                >
                                    核对音频用量契约
                                </Button>
                            )}
                            {canPublish && selectedPrice.tier === "paid" && overview.models.find((item) => item.id === modelId)?.capability === "image" && (
                                <Button
                                    className="mt-2"
                                    size="small"
                                    onClick={() => {
                                        setPendingContract({ kind: "image", price: selectedPrice });
                                        setModelDrawerOpen(false);
                                    }}
                                >
                                    核对图片用量契约
                                </Button>
                            )}
                            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {selectedPrice.items
                                    .filter((item) => !supportsDeepSeekTimePricing(selectedPrice) || DEEPSEEK_TIME_PRICE_KEYS.peak.includes(item.key as (typeof DEEPSEEK_TIME_PRICE_KEYS.peak)[number]))
                                    .map((item) => (
                                        <label key={item.key} className={field}>
                                            {item.key} · {item.price} {item.currency} / {item.per} {item.unit}
                                            <Input
                                                aria-label={`样例用量 ${item.key}`}
                                                value={usage[item.key] || ""}
                                                disabled={["MiniMax-H3", "MiniMax-H3-Max"].includes(selectedPrice.sku) && item.key === "inputAudioSeconds" && new Decimal(item.price).isZero()}
                                                placeholder={["MiniMax-H3", "MiniMax-H3-Max"].includes(selectedPrice.sku) && item.key === "inputAudioSeconds" && new Decimal(item.price).isZero() ? "官方长期免费，计费量为 0" : "样例用量，可手动填写"}
                                                onChange={(event) => {
                                                    setUsage((current) => ({ ...current, [item.key]: event.target.value }));
                                                    setPreview(undefined);
                                                }}
                                            />
                                        </label>
                                    ))}
                            </div>
                            <p className="mt-2 text-zinc-500">
                                {sampleSource || "暂无可匹配的真实用量；可手动填写样例预览。"}{" "}
                                {supportsDeepSeekTimePricing(selectedPrice) ? "三项样例用量会套用预览时选中的高峰或离峰价；实际结算只读取真实响应。" : "样例空项仅在预览中按 0，实际结算不会补零。"}
                            </p>
                            <div className="mt-5 flex flex-wrap gap-2">
                                <Button loading={busy} disabled={!canPublish || !selectedPrice} onClick={() => void runPreview()}>
                                    按样例用量预览
                                </Button>
                                <Button type="primary" disabled={!canPublish || !preview} onClick={publish}>
                                    发布销售版本
                                </Button>
                                <Button disabled={!canPublish || !overview.salesVersions.at(-1)?.priceVersionIds[modelId]} onClick={unbindCurrentPrice}>
                                    取消当前绑定
                                </Button>
                            </div>
                            {preview && (
                                <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/25">
                                    <div className="font-semibold">
                                        样例应收 {preview.quote.points} 积分 <span className="font-normal text-zinc-500">（仅预览，不改变当前扣分方式）</span>
                                    </div>
                                    {preview.deepSeekTier && (
                                        <div className="mt-1 text-xs">
                                            本次预览：{preview.deepSeekTier === "peak" ? "高峰价" : "离峰价"} · UTC {preview.pricingAt}。实际请求按开始预留时的 UTC 时间冻结价档。
                                        </div>
                                    )}
                                    <div className="mt-2 grid gap-1 text-xs">
                                        <div>
                                            用户售价系数：{preview.quote.userCoefficient.value}（命中 {coefficientScopeLabel[preview.quote.userCoefficient.scope] || preview.quote.userCoefficient.scope}）
                                        </div>
                                        {preview.quote.lines.map((line) => (
                                            <div key={line.key}>
                                                {line.key}：{line.quantity} {line.unit} ÷ {line.per} × {line.price} {line.currency} = {line.officialAmount} {line.currency}
                                            </div>
                                        ))}
                                        {preview.quote.currencies.map((item) => (
                                            <div key={item.currency}>
                                                {item.currency} 官网合计 {item.officialAmount}{" "}
                                                {item.currency === "CNY" ? `÷ ${preview.policy.conversion?.cnyPerUsd}（CNY/USD）` : item.currency === "USD" ? "" : `× ${item.usdPerCurrency}（USD/${item.currency}）`} = {item.usdAmount} USD
                                            </div>
                                        ))}
                                        <div>
                                            美元计价合计 {preview.quote.officialAmountUsd} USD × {preview.quote.pointsPerUsd}（积分/USD）× {preview.quote.userCoefficient.value}（用户售价系数）= {preview.quote.points} 积分
                                        </div>
                                        <div>
                                            {preview.quote.rounding}；旧售价：{preview.oldQuote?.points || "无可比较版本"}；差异：{preview.pointsDifference || "—"}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                    {modelDetailView === "conditions" && textControls}
                    {(selectedPrice || modelCapability === "image" || modelCapability === "audio" || publishedSelections.length > 0) && modelDetailView === "bindings" && (
                        <div className="mt-4 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                            {(modelCapability === "image" || modelCapability === "audio") && !publishedPolicy?.priceVersionIds[modelId] && (
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <span>{modelCapability === "image" ? "图片操作" : "音频操作"}</span>
                                    <Select
                                        aria-label={modelCapability === "image" ? "图片按量计价操作" : "音频按量计价操作"}
                                        value={selectionOperation}
                                        className="min-w-28"
                                        options={selectionOperations.map((operation) => ({
                                            value: operation,
                                            label: operation === "generations" ? "图片生成" : operation === "edits" ? "图片编辑" : operation === "generateContent" ? "Gemini 音频生成" : "OpenAI 原生音频",
                                        }))}
                                        onChange={(value) => {
                                            setActivationStatus(undefined);
                                            setSelectionOperation(value);
                                        }}
                                    />
                                    {!publishedSelections.some((item) => item.scope === selectionScope) && <span className="text-amber-700 dark:text-amber-300">该操作尚无已发布选价</span>}
                                </div>
                            )}
                            <div data-testid="model-billing-status" className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
                                <div className="flex flex-wrap items-center gap-2">
                                    <b>
                                        {activationImageOperation
                                            ? activationImageOperation === "generations"
                                                ? "图片生成"
                                                : "图片编辑"
                                            : activationAudioOperation
                                              ? activationAudioOperation === "generateContent"
                                                  ? "Gemini 音频生成"
                                                  : "OpenAI 原生音频"
                                              : "模型"}
                                        当前收费：
                                        {activationStatus?.admission.modelId === modelId && activationStatus.active ? "按量扣分" : activationStatus?.activation?.enabled ? "按量暂停（待核对）" : "固定积分"}
                                    </b>
                                    {activationStatus?.admission.modelId === modelId && !activationStatus.active && (
                                        <Tag color={activationStatus.admission.structuralComplete && activationStatus.shadow?.ready && !draftSaleChanged ? "green" : "gold"}>
                                            {activationStatus.admission.structuralComplete && activationStatus.shadow?.ready && !draftSaleChanged ? "可启用" : "待核对"}
                                        </Tag>
                                    )}
                                </div>
                                {activationStatus?.admission.modelId === modelId && !activationStatus.active && (
                                    <p className="mt-2 text-amber-700 dark:text-amber-300">
                                        {draftSaleChanged
                                            ? "先预览并发布当前模型售价"
                                            : activationStatus.admission.structuralComplete && activationStatus.shadow?.ready
                                              ? "已有渠道与真实影子报价齐备，可明确启用按量扣分；其他渠道仍需单独验收"
                                              : activationStatus.admission.blockers[0] || `等待真实调用形成当前售价与契约的可计价影子报价（还缺 ${activationStatus.shadow?.missingCount || activationStatus.admission.contractIds.length} 份）`}
                                    </p>
                                )}
                                {canPublish && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <Button
                                            type="primary"
                                            disabled={
                                                overview.models.find((item) => item.id === modelId)?.enabled === false ||
                                                !activationStatus ||
                                                activationStatus.admission.modelId !== modelId ||
                                                (activationStatus.active && activationStatus.activation?.textUsageRuleId === activationStatus.admission.textUsageRuleId) ||
                                                draftSaleChanged ||
                                                !activationStatus.admission.structuralComplete ||
                                                !activationStatus.shadow?.ready ||
                                                (activationStatus.admission.capability === "text" &&
                                                    activationStatus.activation?.enabled &&
                                                    activationStatus.activation.textUsageRuleId !== activationStatus.admission.textUsageRuleId &&
                                                    activationStatus.bindings.some((binding) => binding.active && !binding.shadow?.ready))
                                            }
                                            loading={admissionBusy}
                                            onClick={() => void saveActivation(true)}
                                        >
                                            {activationStatus?.active ? "切换已审核规则" : "启用按量扣分"}
                                        </Button>
                                        {activationStatus?.activation?.enabled && (
                                            <Button loading={admissionBusy} onClick={() => void saveActivation(false)}>
                                                恢复固定积分
                                            </Button>
                                        )}
                                        <Button size="small" onClick={() => reloadActivationStatus()}>
                                            刷新状态
                                        </Button>
                                    </div>
                                )}
                                {activationStatus?.admission.modelId === modelId &&
                                    activationStatus.bindings.map((binding) => (
                                        <div key={binding.key} className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                            <span className="font-medium">{binding.channelName}</span>
                                            <span className="break-all text-zinc-500">{binding.key}</span>
                                            <Tag color={binding.active ? "green" : binding.fingerprint && binding.shadow?.ready ? "blue" : "gold"}>{binding.active ? "按量可用" : binding.fingerprint && binding.shadow?.ready ? "可纳入" : "待验收"}</Tag>
                                            {binding.active && activationStatus.admission.capability === "text" && activationStatus.activation?.textUsageRuleId !== activationStatus.admission.textUsageRuleId && (
                                                <Tag color={binding.shadow?.ready ? "blue" : "gold"}>新规则：{binding.shadow?.ready ? "可切换" : "待证据"}</Tag>
                                            )}
                                            {binding.operationContracts.map(({ operation, id }) => (
                                                <Tag key={operation} color={!id ? "gold" : binding.shadow?.receiptIds[id] ? "green" : "blue"}>
                                                    {operation === "generations" ? "创建" : "编辑"}：{!id ? "缺契约" : binding.shadow?.receiptIds[id] ? "已验收" : "待影子报价"}
                                                </Tag>
                                            ))}
                                            {!binding.active && binding.approvalBlocker && <span className="text-amber-700 dark:text-amber-300">{binding.approvalBlocker}</span>}
                                            {!binding.active && <span className="text-zinc-500">{binding.blockers[0] || (binding.shadow ? `缺少 ${binding.shadow.missingCount} 份当前契约的影子报价` : "等待官方价与渠道契约")}</span>}
                                            {canPublish && binding.fingerprint && !binding.shadow?.ready && (!binding.active || activationStatus.admission.capability === "text") && (
                                                <>
                                                    {activationStatus.admission.capability === "image" && (
                                                        <Button size="small" loading={admissionBusy} onClick={() => void revalueImageEvidence(binding.key)}>
                                                            复核已有调用
                                                        </Button>
                                                    )}
                                                    {activationStatus.admission.capability === "text" && (
                                                        <Button size="small" loading={admissionBusy} onClick={() => void revalueTextEvidence(binding.key)}>
                                                            复核已有调用
                                                        </Button>
                                                    )}
                                                </>
                                            )}
                                            {canPublish && (!binding.fingerprint || !binding.shadow?.ready) && (!binding.active || activationStatus.admission.capability === "text") && (
                                                <Button
                                                    size="small"
                                                    onClick={() => {
                                                        setDirectedTest({ bindingKey: binding.key, channelName: binding.channelName, capability: activationStatus.admission.capability });
                                                        setDirectedOperation("generation");
                                                        setDirectedPrompt("");
                                                        setDirectedReference("");
                                                        setDirectedReferenceLabel("");
                                                        setDirectedCreatedImages(directedCreatedImagesByBinding.current[`${modelId}/${binding.key}`] || []);
                                                        setDirectedMentionOpen(false);
                                                        setDirectedTask(null);
                                                        setDirectedEvidence(null);
                                                    }}
                                                >
                                                    执行定向验收
                                                </Button>
                                            )}
                                            {canPublish && overview.models.find((item) => item.id === modelId)?.enabled !== false && activationStatus.active && !binding.active && binding.fingerprint && binding.shadow?.ready && !draftSaleChanged && (
                                                <Button size="small" loading={admissionBusy} onClick={() => void saveActivation(true, binding.key)}>
                                                    确认纳入按量路由
                                                </Button>
                                            )}
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}
                </section>
            </Drawer>

            {activeGroup === "rules" && rulesSub === "coefficients" && (
                <section className={section}>
                    <div className="mt-4">
                        <h3 className="text-sm font-medium">用户售价系数</h3>
                        <p className="mt-1 text-xs text-zinc-500">优先级：具体模型 &gt; 系列 &gt; 厂商 &gt; 默认。每次报价只命中一条；套餐积分优惠不在这里重复计算。</p>
                        <div className="mt-2 space-y-2">
                            {policy.userPriceRules.map((rule, index) => (
                                <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                                    <div className="w-full sm:w-40">
                                        <Select
                                            className="w-full"
                                            aria-label={`规则 ${index + 1} 层级`}
                                            value={rule.scope}
                                            options={[
                                                { value: "default", label: "默认" },
                                                { value: "manufacturer", label: "厂商" },
                                                { value: "series", label: "系列" },
                                                { value: "model", label: "具体模型" },
                                            ]}
                                            disabled={!canPublish}
                                            onChange={(value) => updateRule(index, { scope: value, manufacturer: undefined, series: undefined, modelId: undefined })}
                                        />
                                    </div>
                                    {(rule.scope === "manufacturer" || rule.scope === "series") && (
                                        <div className="min-w-0 flex-1 basis-40">
                                            <Input aria-label={`规则 ${index + 1} 厂商`} placeholder="官方厂商" value={rule.manufacturer || ""} disabled={!canPublish} onChange={(event) => updateRule(index, { manufacturer: event.target.value })} />
                                        </div>
                                    )}
                                    {rule.scope === "series" && (
                                        <div className="min-w-0 flex-1 basis-40">
                                            <Input aria-label={`规则 ${index + 1} 系列`} placeholder="官方系列" value={rule.series || ""} disabled={!canPublish} onChange={(event) => updateRule(index, { series: event.target.value })} />
                                        </div>
                                    )}
                                    {rule.scope === "model" && (
                                        <div className="w-full sm:min-w-60 sm:grow sm:basis-72">
                                            <Cascader
                                                aria-label={`规则 ${index + 1} 模型`}
                                                className="w-full"
                                                style={{ width: "100%" }}
                                                placeholder="厂商 / 能力 / 模型"
                                                value={modelPath(rule.modelId)}
                                                options={modelTree}
                                                showSearch
                                                displayRender={(labels) => labels.at(-1)}
                                                disabled={!canPublish}
                                                onChange={(path) => updateRule(index, { modelId: String(path[2] || "") || undefined })}
                                            />
                                        </div>
                                    )}
                                    <div className="w-full sm:w-40">
                                        <Input aria-label={`规则 ${index + 1} 系数`} placeholder="系数，例如 0.8" value={rule.coefficient} disabled={!canPublish} onChange={(event) => updateRule(index, { coefficient: event.target.value })} />
                                    </div>
                                    <Button className="w-full sm:w-auto" disabled={!canPublish} onClick={() => updatePolicy({ ...policy, userPriceRules: policy.userPriceRules.filter((_, i) => i !== index) })}>
                                        移除
                                    </Button>
                                </div>
                            ))}
                            {canPublish && <Button onClick={() => updatePolicy({ ...policy, userPriceRules: [...policy.userPriceRules, { scope: "default", coefficient: "1" }] })}>添加售价规则</Button>}
                        </div>
                    </div>
                </section>
            )}

            {activeGroup === "rules" && rulesSub === "currency" && (
                <section className={section}>
                    <div className="mt-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-medium">官网价格折算为美元</h3>
                            {canPublish && (
                                <Button
                                    onClick={() => {
                                        setConversionDraft({ ...emptyConversion(), ...overview.exchangeRate });
                                        setConversionOpen(true);
                                    }}
                                >
                                    调整美元/人民币汇率
                                </Button>
                            )}
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">
                            1 USD = {overview.exchangeRate?.cnyPerUsd || "待设置"} CNY（已保存的业务汇率）；1 CNY = {POINTS_PER_CNY} 积分（固定计费基准）；1 USD ={" "}
                            {policy.conversion ? new Decimal(policy.conversion.cnyPerUsd).mul(POINTS_PER_CNY).toFixed() : "待计算"} 积分。汇率调整单独保存，已发布版本保留原汇率。
                        </p>
                        <p className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                            保留官网原币价格及证据；报价时先把各项金额折算为 USD，再合计美元金额 × {policy.conversion?.cnyPerUsd || "美元兑人民币汇率"}（CNY/USD）× {POINTS_PER_CNY}（积分/CNY）×
                            命中的唯一用户售价系数。人民币金额除以美元兑人民币汇率；其他币种须先填写兑美元汇率和依据。最终积分四舍五入到两位；当前仍按固定积分扣费。
                        </p>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            {currencies
                                .filter((currency) => currency !== "USD" && currency !== "CNY")
                                .map((currency) => (
                                    <div key={currency} className="grid gap-2">
                                        <label className={field}>
                                            1 {currency} = 多少 USD
                                            <Input
                                                aria-label={`${currency} 兑美元汇率`}
                                                value={policy.usdPerCurrency[currency] || ""}
                                                placeholder="输入已核实的兑美元汇率"
                                                disabled={!canPublish}
                                                onChange={(event) => updatePolicy({ ...policy, usdPerCurrency: { ...policy.usdPerCurrency, [currency]: event.target.value } })}
                                            />
                                        </label>
                                        <label className={field}>
                                            {currency} 兑美元汇率依据及核对时间
                                            <Input
                                                aria-label={`${currency} 换算依据`}
                                                value={policy.rateEvidence[currency] || ""}
                                                placeholder="财务定价依据或批准记录"
                                                disabled={!canPublish}
                                                onChange={(event) => updatePolicy({ ...policy, rateEvidence: { ...policy.rateEvidence, [currency]: event.target.value } })}
                                            />
                                        </label>
                                    </div>
                                ))}
                        </div>
                    </div>
                </section>
            )}

            <Modal
                title={sourceEditing ? `修改 ${sourceEditing.manufacturer} 官网价格链接` : "新增厂商官网价格链接"}
                open={sourceOpen}
                onCancel={() => setSourceOpen(false)}
                onOk={() => void saveSourceLink()}
                okText="保存链接"
                confirmLoading={busy}
                destroyOnHidden
            >
                <p className="mb-3 text-sm text-zinc-500">此地址供管理员后续参考和新价目预填；已提交候选中的来源证据不会改变。</p>
                <label className={field}>
                    厂商名称（保存后作为稳定标识）
                    <Input aria-label="官网价格厂商名称" value={sourceManufacturer} disabled={Boolean(sourceEditing)} onChange={(event) => setSourceManufacturer(event.target.value)} placeholder="例如 Alibaba Cloud" />
                </label>
                <Input aria-label="官网价格链接地址" value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} />
            </Modal>

            <Drawer
                title={`${catalogEditingEntry ? "修改" : "新增"}${catalogEditor === "series" ? "官方系列" : "官网型号/版本"}`}
                open={Boolean(catalogEditor)}
                onClose={() => setCatalogEditor(null)}
                size="min(520px, 100vw)"
                styles={{ wrapper: { maxWidth: "100vw" }, section: { width: "100%", minWidth: 0, overflowX: "hidden" }, body: { minWidth: 0 } }}
                zIndex={2000}
                destroyOnHidden
            >
                <p className="mb-4 text-xs text-zinc-500">这里只登记官网名称与依据；不会生成价目候选，也不会修改已审核价格。</p>
                <div className="space-y-3">
                    <label className={field}>
                        官方厂商
                        <Input value={catalogDraft.manufacturer} readOnly />
                    </label>
                    {catalogEditor === "version" && (
                        <label className={field}>
                            所属系列（可选）
                            <Select
                                allowClear
                                aria-label="目录所属系列"
                                className="w-full"
                                value={catalogDraft.parentId || undefined}
                                options={(catalogEditorFromCandidate ? candidateCatalog : visibleCatalog)
                                    .filter((entry) => entry.kind === "series" && entry.manufacturer === catalogDraft.manufacturer)
                                    .map((entry) => ({ value: entry.id, label: entry.name }))}
                                onChange={(parentId) => setCatalogDraft({ ...catalogDraft, parentId: parentId || "" })}
                            />
                        </label>
                    )}
                    <label className={field}>
                        {catalogEditor === "series" ? "系列名称" : "官网型号/版本名称"}
                        <Input aria-label="目录名称" value={catalogDraft.name} onChange={(event) => setCatalogDraft({ ...catalogDraft, name: event.target.value })} />
                    </label>
                    {(!catalogDraft.parentId || catalogEditor === "series") && (
                        <label className={field}>
                            适用能力
                            <Select
                                aria-label="目录适用能力"
                                className="w-full"
                                value={catalogDraft.capability}
                                options={Object.entries(capabilityLabels).map(([value, label]) => ({ value, label }))}
                                onChange={(capability) => setCatalogDraft({ ...catalogDraft, capability })}
                            />
                        </label>
                    )}
                    {catalogEditor === "version" && (
                        <label className={field}>
                            官方模型 ID / SKU
                            <Input aria-label="目录官方模型 ID" value={catalogDraft.sku} onChange={(event) => setCatalogDraft({ ...catalogDraft, sku: event.target.value })} />
                        </label>
                    )}
                    <label className={field}>
                        官网 HTTPS 来源
                        <Input aria-label="目录官网来源" value={catalogDraft.sourceUrl} onChange={(event) => setCatalogDraft({ ...catalogDraft, sourceUrl: event.target.value })} />
                    </label>
                    <label className={field}>
                        官网命名依据
                        <Input.TextArea aria-label="目录官网命名依据" rows={4} value={catalogDraft.evidence} onChange={(event) => setCatalogDraft({ ...catalogDraft, evidence: event.target.value })} />
                    </label>
                </div>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <Button onClick={() => setCatalogEditor(null)}>取消</Button>
                    <Button type="primary" loading={catalogBusy} onClick={() => void saveCatalogEntry()}>
                        保存到目录
                    </Button>
                </div>
            </Drawer>

            <Modal title="调整美元/人民币汇率" open={conversionOpen} onCancel={() => setConversionOpen(false)} onOk={() => void saveConversion()} okText="保存汇率" confirmLoading={busy} destroyOnHidden>
                <p className="mb-4 text-sm text-zinc-500">汇率可单独保存。计费基准固定为 1 CNY = {POINTS_PER_CNY} 积分；套餐发放量不会改变它。</p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className={field}>
                        1 USD = 多少 CNY
                        <Input aria-label="美元兑人民币汇率" value={conversionDraft.cnyPerUsd} onChange={(event) => setConversionDraft({ ...conversionDraft, cnyPerUsd: event.target.value })} />
                    </label>
                    <label className={`${field} sm:col-span-2`}>
                        换算依据
                        <Input aria-label="汇率换算依据" value={conversionDraft.evidence} onChange={(event) => setConversionDraft({ ...conversionDraft, evidence: event.target.value })} />
                    </label>
                </div>
                <p className="mt-3 text-xs text-zinc-500">保存后以固定积分基准计算售价草稿；发布销售版本后影响后续预览。当前固定积分扣费不受影响。</p>
            </Modal>

            <Modal
                title={candidateOrigin === "correction" ? `修订官网发现 · ${correctionTarget?.observation.officialModelId || ""}` : editingCandidate ? `修改官方价目候选 · ${editingCandidate.logicalModelId}` : "录入官方价目候选"}
                open={candidateOpen}
                onCancel={closeCandidate}
                onOk={() => void (candidateOrigin === "correction" ? saveObservationCorrection() : submitCandidate())}
                okText={candidateOrigin === "correction" ? "保存修订，仍待确认" : editingCandidate ? "保存并重新提交审核" : "提交待审核"}
                okButtonProps={{ disabled: candidateOrigin !== "correction" && Boolean(priceReferenceReview?.some((reviewed) => !reviewed)) }}
                confirmLoading={busy}
                width="min(760px, 100vw)"
                styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
            >
                {candidateOrigin === "discovery" && (
                    <div className="mb-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                        <p>此表单与“录入官方价目”共用同一提交流程。原官网证据档案不会随编辑改变；价目审核后可再关联逻辑模型。</p>
                        <p>系列、版本、免费/付费档与每项单价须对照官网确认；未知字段请保持空白，实际免费价才填写 0。</p>
                        <p>当前待补齐：{officialPriceDraftIssues(candidate).join("、") || "无；仍请逐项检查来源及适用条件"}</p>
                        <p>未关联逻辑模型的价目可以审核存档，但不能用于售价发布和自动扣费。</p>
                    </div>
                )}
                {candidateOrigin === "correction" && correctionTarget && (
                    <div className="mb-3 space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
                        <p>
                            价格组 {correctionTarget.variantIndex + 1} · 第 {(correctionTarget.observation.amendments?.length || 0) + 1} 次修订。此处只修改 AI 提取的分项；官网原始证据不变，保存后不会提交正式候选。
                        </p>
                        <p className="whitespace-pre-wrap break-all">原始官网摘录：{correctionTarget.observation.priceVariants?.[correctionTarget.variantIndex]?.evidence || correctionTarget.observation.evidence}</p>
                        <label className={field}>
                            修订原因
                            <Input.TextArea aria-label="官网发现修订原因" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} />
                        </label>
                    </div>
                )}
                {candidateOrigin !== "correction" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className={field}>
                            模型能力
                            <Select
                                aria-label="官方价模型能力"
                                className="w-full"
                                disabled={Boolean(editingCandidate?.logicalModelId)}
                                value={candidateCapability}
                                placeholder="按官网选择文本、图片、视频或音频"
                                options={Object.entries(capabilityLabels).map(([value, label]) => ({ value, label }))}
                                onChange={(capability) => setCandidate({ ...candidate, capability: capability as OfficialPriceInput["capability"], catalogVersionId: undefined, series: "", officialVersion: "", sku: "", items: [], conditions: "" })}
                            />
                            {candidate.logicalModelId && <span className="text-xs text-zinc-500">历史候选已关联 {candidate.logicalModelId}，仍按原绑定审核。</span>}
                        </label>
                        <label className={field}>
                            来源
                            <Select
                                aria-label="官方价来源"
                                className="w-full"
                                value={candidate.sourceKind}
                                options={[
                                    { value: "manual", label: "官方页面留证录入" },
                                    { value: "machine", label: "机器可读接口候选" },
                                ]}
                                onChange={(value) => setCandidate({ ...candidate, sourceKind: value })}
                            />
                        </label>
                        <label className={field}>
                            官方厂商
                            <Select
                                aria-label="官方厂商"
                                className="w-full"
                                showSearch
                                optionFilterProp="label"
                                placeholder="从官网链接选择"
                                value={candidate.manufacturer || undefined}
                                options={overview.officialSources.map((source) => ({ value: source.manufacturer, label: source.manufacturer }))}
                                onChange={(manufacturer) => {
                                    setStructurePickerOpen(false);
                                    setShowLegacySeries(false);
                                    const source = overview.officialSources.find((item) => item.manufacturer === manufacturer);
                                    setReferences({ series: [], versions: [], approved: [], pending: [] });
                                    setCandidate({ ...candidate, manufacturer, catalogVersionId: undefined, processingTier: undefined, series: "", officialVersion: "", sku: "", items: [], conditions: "", sourceUrl: source?.url || "" });
                                }}
                            />
                        </label>
                        {candidateOrigin === "manual" && (
                            <label className={field}>
                                从官方型号目录选择（可选）
                                <Select
                                    aria-label="选择目录官网型号"
                                    className="w-full"
                                    showSearch
                                    optionFilterProp="label"
                                    disabled={!candidate.manufacturer}
                                    value={candidate.catalogVersionId || undefined}
                                    placeholder="按型号或官方模型 ID 搜索"
                                    options={candidateCatalogVersions.map((entry) => ({
                                        value: entry.id,
                                        label: `${entry.name} · ${entry.sku} · ${candidateCatalog.find((series) => series.id === entry.parentId)?.name || "未分类"}`,
                                    }))}
                                    onChange={(id) => {
                                        const entry = candidateCatalogVersions.find((item) => item.id === id);
                                        if (!entry) return;
                                        setCandidate({
                                            ...candidate,
                                            catalogVersionId: entry.id,
                                            series: candidateCatalog.find((item) => item.id === entry.parentId)?.name || "",
                                            officialVersion: entry.name,
                                            sku: entry.sku || "",
                                            sourceUrl: entry.sourceUrl,
                                            items: [],
                                            conditions: "",
                                        });
                                    }}
                                />
                            </label>
                        )}
                        <div className={field}>
                            <span className="flex items-center justify-between gap-2">
                                官方系列（可选）
                                <div className="flex gap-1">
                                    {candidate.manufacturer && (
                                        <Button
                                            size="small"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                setShowLegacySeries((current) => !current);
                                            }}
                                        >
                                            {showLegacySeries ? "隐藏历史建议" : "查看历史建议"}
                                        </Button>
                                    )}
                                    {canReview && candidateOrigin === "manual" && (
                                        <Button
                                            size="small"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                openCatalogEditor("series", true);
                                            }}
                                        >
                                            目录中新增
                                        </Button>
                                    )}
                                </div>
                            </span>
                            <AutoComplete
                                aria-label="官方系列"
                                className="w-full"
                                value={candidate.series}
                                disabled={!candidate.manufacturer}
                                placeholder="选择已有系列或输入官网系列"
                                options={candidateSeriesOptions}
                                onChange={(series) => setCandidate({ ...candidate, series, catalogVersionId: undefined })}
                            />
                        </div>
                        <div className={field}>
                            <span className="flex items-center justify-between gap-2">
                                官方模型版本
                                {canReview && candidateOrigin === "manual" && (
                                    <Button
                                        size="small"
                                        onClick={(event) => {
                                            event.preventDefault();
                                            openCatalogEditor("version", true);
                                        }}
                                    >
                                        目录中新增
                                    </Button>
                                )}
                            </span>
                            <AutoComplete
                                aria-label="官方模型版本"
                                className="w-full"
                                value={candidate.officialVersion}
                                disabled={!candidate.manufacturer}
                                placeholder="选择已录版本或输入官网版本"
                                options={[
                                    ...new Set([
                                        ...references.versions,
                                        ...candidateCatalog
                                            .filter(
                                                (item) =>
                                                    item.kind === "version" &&
                                                    item.manufacturer === candidate.manufacturer &&
                                                    (candidateCatalog.some((parent) => parent.id === item.parentId && parent.name === candidate.series) || (!candidate.series && !item.parentId)),
                                            )
                                            .map((item) => item.name),
                                    ]),
                                ]
                                    .sort()
                                    .map((value) => ({ value }))}
                                onChange={(officialVersion) => {
                                    const catalogVersion = candidateCatalog.find(
                                        (entry) =>
                                            entry.kind === "version" && entry.name === officialVersion && (candidateCatalog.some((parent) => parent.id === entry.parentId && parent.name === candidate.series) || (!candidate.series && !entry.parentId)),
                                    );
                                    setCandidate(
                                        candidateOrigin === "discovery"
                                            ? { ...candidate, officialVersion, catalogVersionId: catalogVersion?.sku === candidate.sku ? catalogVersion.id : undefined }
                                            : { ...candidate, officialVersion, catalogVersionId: catalogVersion?.id, sku: catalogVersion?.sku || "", items: [], conditions: "" },
                                    );
                                }}
                            />
                        </div>
                        <label className={field}>
                            官方模型 ID／产品标识
                            <Input
                                aria-label="官方模型 ID／产品标识"
                                value={candidate.sku}
                                onChange={(event) => {
                                    const sku = event.target.value;
                                    const catalogVersionId = candidateCatalog.some((entry) => entry.id === candidate.catalogVersionId && entry.sku === sku) ? candidate.catalogVersionId : undefined;
                                    const conditions =
                                        candidateConditionChoices.includes(candidate.conditions) && !officialPriceConditionChoices(candidate.manufacturer, candidateCapability || "", sku).includes(candidate.conditions) ? "" : candidate.conditions;
                                    setCandidate(candidateOrigin === "discovery" ? { ...candidate, sku, catalogVersionId, conditions } : { ...candidate, sku, catalogVersionId, conditions, items: [] });
                                }}
                            />
                            <span className="text-xs text-zinc-500">{candidate.catalogVersionId ? "已关联官网目录；保存时按当前目录名称显示" : "未关联官网目录；仍可按原流程手动录价"}</span>
                        </label>
                        {(
                            [
                                ["sourceUrl", "官方 HTTPS 来源"],
                                ["observedAt", "证据查看时间（ISO）"],
                                ["effectiveFrom", "生效开始（可选 ISO）"],
                                ["effectiveTo", "生效结束（可选 ISO）"],
                            ] as const
                        ).map(([key, label]) => (
                            <label key={key} className={field}>
                                {label}
                                <Input aria-label={label} value={candidate[key] || ""} onChange={(event) => setCandidate({ ...candidate, [key]: event.target.value })} />
                            </label>
                        ))}
                        <label className={field}>
                            免费/付费档
                            <Select
                                aria-label="免费付费档"
                                className="w-full"
                                value={candidate.tier || undefined}
                                placeholder="请按官网确认档位"
                                options={[
                                    { value: "free", label: "免费档" },
                                    { value: "paid", label: "付费档" },
                                ]}
                                onChange={(value) => setCandidate(candidateOrigin === "discovery" ? { ...candidate, tier: value } : { ...candidate, tier: value, items: [], conditions: "" })}
                            />
                        </label>
                        {candidate.manufacturer === "OpenAI" && (
                            <label className={field}>
                                官网服务方式
                                <Select
                                    aria-label="OpenAI 处理档位"
                                    className="w-full"
                                    allowClear
                                    placeholder="按官网表格选择 Standard、Batch 等"
                                    value={candidate.processingTier}
                                    options={candidateCapability === "image" ? openAiProcessingTierOptions.slice(0, 2) : openAiProcessingTierOptions}
                                    onChange={(processingTier) => setCandidate({ ...candidate, processingTier })}
                                />
                            </label>
                        )}
                        {candidate.officialVersion && (
                            <div className="sm:col-span-2 space-y-2 text-xs">
                                {references.pending
                                    .filter((item) => item.logicalModelId === candidate.logicalModelId && item.tier === candidate.tier && item.processingTier === candidate.processingTier)
                                    .map((item) => (
                                        <p key={item.id} className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                            {isMainlandByteDancePrice(item) ? `现有 ${item.sku} 候选是国内报价；请按 BytePlus 海外型号和美元价另录候选。` : `此逻辑模型已有待审核候选：${item.sku}。请先查看现有候选，勿重复提交。`}
                                        </p>
                                    ))}
                                {references.approved
                                    .filter((item) => item.tier === candidate.tier && item.officialVersion === candidate.officialVersion)
                                    .map((item) => (
                                        <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                                            <span>
                                                已审核：{item.sku} · {processingTierLabel(item) && `${processingTierLabel(item)} · `}
                                                {item.items[0]?.key} {item.items[0]?.price} {item.items[0]?.currency}/{item.items[0]?.per} {item.items[0]?.unit} · {item.items.length} 项
                                            </span>
                                            <Button
                                                size="small"
                                                disabled={Boolean(candidate.sku && candidate.sku !== item.sku)}
                                                onClick={() => {
                                                    setPriceReferenceReview(null);
                                                    setPriceReferenceSource("");
                                                    setCandidate({
                                                        ...candidate,
                                                        sku: item.sku,
                                                        processingTier: candidate.processingTier || item.processingTier,
                                                        conditions: item.conditions,
                                                        sourceUrl: item.sourceUrl,
                                                        evidence: item.evidence,
                                                        effectiveFrom: item.effectiveFrom,
                                                        effectiveTo: item.effectiveTo,
                                                        items: item.items.map((price) => ({ ...price })),
                                                    });
                                                }}
                                            >
                                                引用分项草稿
                                            </Button>
                                        </div>
                                    ))}
                                {references.approved.some((item) => item.tier === candidate.tier && item.officialVersion === candidate.officialVersion) && (
                                    <p className="text-zinc-500">引用后仍须重新核对官网、适用条件和查看时间，提交后进入本逻辑模型的待审核候选。</p>
                                )}
                            </div>
                        )}
                        <label className={field}>
                            {candidateConditionChoices.length ? "官网价目类别 / 适用条件" : "适用条件"}
                            {candidateConditionChoices.length ? (
                                <AutoComplete
                                    aria-label="价目适用条件"
                                    className="w-full"
                                    value={candidate.conditions}
                                    options={candidateConditionChoices.map((value) => ({ value }))}
                                    placeholder="选择官网类别；其他条件可手动填写"
                                    onChange={(conditions) => setCandidate({ ...candidate, conditions })}
                                />
                            ) : (
                                <Input aria-label="价目适用条件" value={candidate.conditions} placeholder="地区、分辨率、上下文档位等" onChange={(event) => setCandidate({ ...candidate, conditions: event.target.value })} />
                            )}
                        </label>
                        <label className={`${field} sm:col-span-2`}>
                            官方页面或接口证据
                            <Input.TextArea aria-label="官方价证据" value={candidate.evidence} rows={2} onChange={(event) => setCandidate({ ...candidate, evidence: event.target.value })} />
                        </label>
                    </div>
                )}
                {candidateOrigin === "correction" && (
                    <label className={field}>
                        价格组适用条件
                        <Input aria-label="价格组适用条件" value={candidate.conditions} onChange={(event) => setCandidate({ ...candidate, conditions: event.target.value })} />
                    </label>
                )}
                <h3 className="mt-4 text-sm font-medium">分项价目 · 每项独立核对计费条件</h3>
                {candidateOrigin !== "correction" && (
                    <div className="mt-2 space-y-2">
                        <Button disabled={!candidate.manufacturer || !candidateCapability} onClick={() => setStructurePickerOpen((open) => !open)}>
                            引用已审核分项结构
                        </Button>
                        {structurePickerOpen && (
                            <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
                                <p>仅列出同厂商、同能力模型的已审核价目。可只引用分项结构，或将单价与币种一并带入作参考；目标型号的适用条件、SKU、官方证据及生效时间不会复制，参考价格须逐项核对。</p>
                                {structureLoading ? (
                                    <p>正在读取已审核价目…</p>
                                ) : structureReferences.length ? (
                                    structureReferences.map((item) => (
                                        <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950">
                                            <div className="min-w-0">
                                                <p className="font-medium">
                                                    {item.sku} · {item.series} · {item.items.length} 项{item.series === candidate.series ? " · 同系列" : ""}
                                                </p>
                                                <p className="break-all text-zinc-500">{item.items.map((price) => `${price.key} / ${price.per} ${price.unit}`).join("、")}</p>
                                            </div>
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    const apply = () => {
                                                        setCandidate((current) => ({ ...current, items: officialPriceStructureItems(item.items) }));
                                                        setPriceReferenceReview(null);
                                                        setPriceReferenceSource("");
                                                        setStructurePickerOpen(false);
                                                        message.info("已带入分项结构；请逐项填写并核对目标型号的价格和证据");
                                                    };
                                                    if (candidate.items.length) modal.confirm({ title: "替换当前分项草稿？", content: "现有分项会被参考结构替换，已填单价和币种不会保留。", okText: "替换分项", onOk: apply });
                                                    else apply();
                                                }}
                                            >
                                                用此结构创建草稿
                                            </Button>
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    const apply = () => {
                                                        setCandidate((current) => ({ ...current, items: officialPriceReferenceItems(item.items) }));
                                                        setPriceReferenceSource(item.sku);
                                                        setPriceReferenceReview(item.items.map(() => false));
                                                        setPriceReferenceIdentity(priceReferenceIdentityOf(candidate));
                                                        setStructurePickerOpen(false);
                                                        message.info("已带入可编辑参考价；请与目标型号官网逐项核对");
                                                    };
                                                    if (candidate.items.length) modal.confirm({ title: "替换当前分项草稿？", content: "现有分项会被参考结构和价格替换；新价格只作参考，须逐项核对目标官网。", okText: "带入参考价", onOk: apply });
                                                    else apply();
                                                }}
                                            >
                                                带入结构和参考价
                                            </Button>
                                        </div>
                                    ))
                                ) : (
                                    <p>暂无同厂商、同能力的已审核价目。请手动添加分项。</p>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {priceReferenceReview && candidateOrigin !== "correction" && (
                    <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                        参考来源：{priceReferenceSource}。复制的单价与币种只是草稿；请核对目标型号的官网价格、适用条件、证据和查看时间。未核对完不能提交。
                    </p>
                )}
                {!candidate.items.length && <p className="mt-1 text-xs text-zinc-500">尚未填写分项。请按官网计费项目逐项录入；实际免费价才填写 0。</p>}
                <div className="mt-2 space-y-2">
                    {candidate.items.map((item, index) => (
                        <div key={index} className="grid gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800 sm:grid-cols-2">
                            <div className="flex items-center justify-between sm:col-span-2">
                                <b className="text-xs">计费分项 {index + 1}</b>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        setCandidate({ ...candidate, items: candidate.items.filter((_, i) => i !== index) });
                                        if (priceReferenceReview) setPriceReferenceReview(priceReferenceReview.filter((_, i) => i !== index));
                                        if (candidateOrigin === "correction") setCorrectionEvidence(correctionEvidence.filter((_, i) => i !== index));
                                    }}
                                >
                                    移除项目
                                </Button>
                            </div>
                            <label className={field}>
                                分项标识
                                <Input aria-label={`项目 ${index + 1} 标识`} placeholder="例如 outputTokens_1080p_withInputVideo" value={item.key} onChange={(event) => updateItem(index, { key: event.target.value })} />
                            </label>
                            <label className={field}>
                                官方单价
                                <Input aria-label={`项目 ${index + 1} 单价`} placeholder="官方单价" value={item.price} onChange={(event) => updateItem(index, { price: event.target.value })} />
                            </label>
                            <label className={field}>
                                币种（国际站 USD）
                                <Input aria-label={`项目 ${index + 1} 币种`} placeholder="USD" value={item.currency} onChange={(event) => updateItem(index, { currency: event.target.value.toUpperCase() })} />
                            </label>
                            <label className={field}>
                                计价单位
                                <Input aria-label={`项目 ${index + 1} 单位`} placeholder="token / second / image" value={item.unit} onChange={(event) => updateItem(index, { unit: event.target.value })} />
                            </label>
                            <label className={field}>
                                每多少单位计价
                                <Input aria-label={`项目 ${index + 1} 报价数量`} placeholder="例如 1000000" value={item.per} onChange={(event) => updateItem(index, { per: event.target.value })} />
                            </label>
                            <label className={field}>
                                本项适用条件
                                {candidateItemConditionChoices.length ? (
                                    <AutoComplete
                                        aria-label={`项目 ${index + 1} 适用条件`}
                                        className="w-full"
                                        value={item.condition || ""}
                                        options={candidateItemConditionChoices.map((value) => ({ value }))}
                                        placeholder="选择经核实的条件，或手动填写"
                                        onChange={(condition) => updateItem(index, { condition })}
                                    />
                                ) : (
                                    <Input aria-label={`项目 ${index + 1} 适用条件`} placeholder="例如 1080p 输出且包含输入视频" value={item.condition || ""} onChange={(event) => updateItem(index, { condition: event.target.value })} />
                                )}
                            </label>
                            {priceReferenceReview && candidateOrigin !== "correction" && (
                                <Checkbox checked={priceReferenceReview[index] ?? true} onChange={(event) => setPriceReferenceReview(priceReferenceReview.map((reviewed, i) => (i === index ? event.target.checked : reviewed)))}>
                                    已核对目标型号的本项价格与币种
                                </Checkbox>
                            )}
                            {candidateOrigin === "correction" && (
                                <label className={`${field} sm:col-span-2`}>
                                    本项对应的原始官网摘录
                                    <Input.TextArea
                                        aria-label={`项目 ${index + 1} 官网原文摘录`}
                                        value={correctionEvidence[index] || ""}
                                        rows={2}
                                        onChange={(event) => setCorrectionEvidence(correctionEvidence.map((value, i) => (i === index ? event.target.value : value)))}
                                    />
                                </label>
                            )}
                        </div>
                    ))}
                    <Button
                        onClick={() => {
                            setCandidate({ ...candidate, items: [...candidate.items, { key: "", unit: "", per: "", price: "", currency: "" }] });
                            if (priceReferenceReview) setPriceReferenceReview([...priceReferenceReview, true]);
                            if (candidateOrigin === "correction") setCorrectionEvidence([...correctionEvidence, ""]);
                        }}
                    >
                        添加计费项目
                    </Button>
                </div>
            </Modal>
            <Modal
                title={`撤销 ${invalidationTarget?.officialModelId || ""} 的证据确认`}
                open={Boolean(invalidationTarget)}
                onCancel={() => setInvalidationTarget(null)}
                onOk={() => void invalidateObservation()}
                okText="撤销确认并解除关联"
                okButtonProps={{ disabled: !invalidationReason.trim(), danger: true }}
            >
                <p className="mb-3 text-sm text-zinc-500">测试性确认将标记为驳回并保留审核记录；关联逻辑模型会解除。已提交的价目候选需单独审核。</p>
                <Input.TextArea aria-label="撤销确认原因" value={invalidationReason} onChange={(event) => setInvalidationReason(event.target.value)} placeholder="说明证据或结构化价目为何需要重核" />
            </Modal>
        </div>
    );

    function updateRule(index: number, patch: Partial<UserPriceRule>) {
        updatePolicy({ ...policy, userPriceRules: policy.userPriceRules.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
    }
    function updateItem(index: number, patch: Partial<OfficialPriceInput["items"][number]>) {
        setCandidate({ ...candidate, items: candidate.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
        if (priceReferenceReview) setPriceReferenceReview(priceReferenceReview.map((reviewed, i) => (i === index ? false : reviewed)));
    }
}

function FlatTextContractDrawer({ price, logicalModelId, onClose }: { price: OfficialPriceVersion; logicalModelId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [options, setOptions] = useState<FlatTextContractOptions>();
    const [bindingKey, setBindingKey] = useState("");
    const [history, setHistory] = useState<FlatTextContractHistory>();
    const [draft, setDraft] = useState<FlatTextPriceContractInput>();
    const [inclusiveInput, setInclusiveInput] = useState(false);
    const [busy, setBusy] = useState(false);
    const binding = bindingKey ? options?.bindings[Number(bindingKey)] : undefined;
    const deepSeekPrice = supportsDeepSeekTimePricing(price);
    const schedule = price.textPriceSchedule;
    const priceItems = schedule ? officialItemsForTextPriceGroup(schedule.groups.find((group) => group.selector.processingMode === "standard")!) : price.items;
    const defaultMeters = (): Record<string, FlatTextMeter[]> =>
        Object.fromEntries(priceItems.map((item) => [item.key, deepSeekPrice ? [item.key.startsWith("cacheHit") ? "cachedInputTokens" : item.key.startsWith("cacheMiss") ? "uncachedInputTokens" : "outputTokens"] : []]));

    useEffect(() => {
        let active = true;
        void getFlatTextContractOptions(price.id, logicalModelId)
            .then((data) => {
                if (!active) return;
                setOptions(data);
                if (data.bindings.length === 1) setBindingKey("0");
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "渠道绑定加载失败");
            });
        return () => {
            active = false;
        };
    }, [price.id, logicalModelId, message]);

    useEffect(() => {
        if (!binding) return;
        let active = true;
        setHistory(undefined);
        setDraft(undefined);
        void getFlatTextContractHistory(price.id, binding.channelId, binding.requestedModel)
            .then((data) => {
                if (!active) return;
                const current = data.contracts.find((item) => item.current);
                setInclusiveInput(deepSeekPrice || Boolean(current && Object.values(current.itemMeters).some((meters) => meters.includes("uncachedInputTokens"))));
                setHistory(data);
                setDraft(
                    current
                        ? {
                              channelId: current.channelId,
                              protocol: current.protocol,
                              requestedModel: current.requestedModel,
                              reportedModel: current.reportedModel,
                              scope: current.scope,
                              region: current.region,
                              serviceTier: current.serviceTier,
                              itemMeters: current.itemMeters,
                              evidence: current.evidence,
                              identity:
                                  binding.requestedModel === price.sku
                                      ? undefined
                                      : current.identity?.channelBindingId === binding.channelBindingId
                                        ? current.identity
                                        : { channelBindingId: binding.channelBindingId || "", officialSku: price.sku, operation: "generation", modelIdentity: "response-required", sourceUrl: "", evidence: "" },
                              requestLimits: current.requestLimits,
                              reservationEstimate: current.reservationEstimate || { method: "request-size-recent-output", sourceUrl: "", evidence: "" },
                              contextTiers: current.contextTiers,
                          }
                        : {
                              channelId: binding.channelId,
                              protocol: deepSeekPrice ? "openai-chat" : binding.suggestedProtocol || "openai-chat",
                              requestedModel: binding.requestedModel,
                              reportedModel: "",
                              scope: deepSeekPrice ? "global-standard-deepseek-utc" : schedule ? "global-standard-text-tiered" : "global-standard-text-flat",
                              region: "global",
                              serviceTier: "default",
                              itemMeters: defaultMeters(),
                              evidence: "",
                              reservationEstimate: { method: "request-size-recent-output", sourceUrl: "", evidence: "" },
                              ...(binding.requestedModel !== price.sku
                                  ? { identity: { channelBindingId: binding.channelBindingId || "", officialSku: price.sku, operation: "generation" as const, modelIdentity: "response-required" as const, sourceUrl: "", evidence: "" } }
                                  : {}),
                          },
                );
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "契约历史加载失败");
            });
        return () => {
            active = false;
        };
    }, [price.id, price.items, price.textPriceSchedule, bindingKey, options, message]);

    const supportsInclusiveInput = draft?.protocol === "openai-chat" || draft?.protocol === "openai-responses";
    const requiredMeters = (supportsInclusiveInput && inclusiveInput ? options?.inclusiveInputMeters : draft && options?.protocolMeters[draft.protocol]) || [];
    const tiered = draft?.scope === "global-standard-text-tiered" && !schedule;
    const deepSeekTiered = draft?.scope === "global-standard-deepseek-utc";
    const tiers = draft?.contextTiers;
    const itemKeys = priceItems.map((item) => item.key);
    const tierGroups: readonly (readonly string[])[] = deepSeekTiered ? [DEEPSEEK_TIME_PRICE_KEYS.peak, DEEPSEEK_TIME_PRICE_KEYS.offPeak] : tiered ? [tiers?.shortItemKeys || [], tiers?.longItemKeys || []] : [itemKeys];
    const mappedMetersFor = (key: string) => tierGroups.find((group) => group.includes(key))?.flatMap((itemKey) => draft?.itemMeters[itemKey] || []) || [];
    const tiersComplete =
        !tiered ||
        Boolean(
            tiers &&
            Number.isSafeInteger(tiers.thresholdInputTokens) &&
            tiers.thresholdInputTokens > 0 &&
            tiers.sourceUrl.startsWith("https://") &&
            tiers.evidence.trim() &&
            tiers.shortItemKeys.length &&
            tiers.longItemKeys.length &&
            [...tiers.shortItemKeys, ...tiers.longItemKeys].length === itemKeys.length &&
            new Set([...tiers.shortItemKeys, ...tiers.longItemKeys]).size === itemKeys.length &&
            itemKeys.every((key) => tiers.shortItemKeys.includes(key) || tiers.longItemKeys.includes(key)),
        );
    const metersComplete = tierGroups.every((group) => {
        const mapped = group.flatMap((key) => draft?.itemMeters[key] || []);
        return mapped.length === requiredMeters.length && new Set(mapped).size === requiredMeters.length && requiredMeters.every((meter) => mapped.includes(meter));
    });
    const limits = draft?.requestLimits;
    const limitsComplete = !limits || ([limits.maxInputTokens, limits.maxOutputTokens, limits.maxCandidates].every((value) => Number.isSafeInteger(value) && value > 0) && limits.sourceUrl.trim().startsWith("https://") && Boolean(limits.evidence.trim()));
    const estimate = draft?.reservationEstimate;
    const estimateComplete = Boolean(estimate?.sourceUrl.startsWith("https://") && estimate.evidence.trim());
    const identityComplete =
        binding?.requestedModel === price.sku ||
        Boolean(
            draft?.identity &&
            draft.identity.channelBindingId === binding?.channelBindingId &&
            draft.identity.officialSku === price.sku &&
            draft.identity.sourceUrl.startsWith("https://") &&
            draft.identity.evidence.trim() &&
            (draft.identity.modelIdentity === "reviewed-request" || draft.reportedModel.trim()),
        );
    const complete = Boolean(
        limitsComplete &&
        estimateComplete &&
        identityComplete &&
        tiersComplete &&
        metersComplete &&
        draft &&
        history &&
        draft.serviceTier.trim() &&
        draft.evidence.trim() &&
        priceItems.length &&
        priceItems.every((item) => item.unit.toLowerCase() === "token" && draft.itemMeters[item.key]?.length),
    );
    const save = async () => {
        if (!draft || !binding || !history || !complete) return;
        setBusy(true);
        try {
            await reviewFlatTextContract(price.id, draft, history.contracts.find((item) => item.current)?.id || null, logicalModelId);
            setHistory(await getFlatTextContractHistory(price.id, binding.channelId, binding.requestedModel));
            message.success("用量契约已审核留存；尚未启用真实扣费");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "计费契约审核失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Drawer title="核对纯文本用量契约" width="min(760px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open onClose={onClose}>
            <div className="space-y-4 text-sm">
                <p className="text-zinc-600 dark:text-zinc-300">逐渠道确认实际响应型号、服务档及用量字段如何对应已审核的官方分项。此处仅留存核对证据，不改变当前固定积分扣费。</p>
                <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <b>
                        {price.manufacturer} / {price.officialVersion}
                    </b>
                    <div className="mt-1 break-all text-zinc-500">
                        {price.sku} · {price.conditions}
                    </div>
                    <a className="mt-1 block break-all text-blue-700 underline dark:text-blue-300" href={price.sourceUrl} target="_blank" rel="noreferrer">
                        查看该版本的官网证据
                    </a>
                </div>
                <label className="block space-y-1">
                    启用的渠道与上游型号
                    <div>
                        <Select
                            aria-label="契约渠道绑定"
                            className="w-full"
                            showSearch
                            optionFilterProp="label"
                            placeholder="选择已启用绑定"
                            value={bindingKey || undefined}
                            options={options?.bindings.map((item, index) => ({ value: String(index), label: `${item.channelName} / ${item.requestedModel}` })) || []}
                            onChange={setBindingKey}
                        />
                    </div>
                </label>
                {options && !options.bindings.length && <p className="text-amber-700 dark:text-amber-300">该文本逻辑模型暂无已启用的渠道绑定，不能审核计费契约。</p>}
                {draft && history && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1">
                                实际响应协议
                                <div>
                                    <Select
                                        aria-label="契约响应协议"
                                        className="w-full"
                                        value={draft.protocol}
                                        options={Object.keys(options?.protocolMeters || {})
                                            .filter((protocol) => !deepSeekPrice || protocol === "openai-chat")
                                            .map((protocol) => ({ value: protocol, label: protocol }))}
                                        onChange={(protocol) => {
                                            setInclusiveInput(deepSeekPrice);
                                            setDraft({
                                                ...draft,
                                                protocol,
                                                scope: deepSeekPrice ? "global-standard-deepseek-utc" : schedule ? "global-standard-text-tiered" : protocol === "openai-chat" || protocol === "openai-responses" ? draft.scope : "global-standard-text-flat",
                                                contextTiers: schedule ? undefined : protocol === "openai-chat" || protocol === "openai-responses" ? draft.contextTiers : undefined,
                                                requestLimits: undefined,
                                                itemMeters: defaultMeters(),
                                            });
                                        }}
                                    />
                                </div>
                            </label>
                            <label className="space-y-1">
                                响应报告的模型 ID（可空）
                                <Input aria-label="契约响应型号" value={draft.reportedModel} placeholder="未报告时按已审核请求型号计价" onChange={(event) => setDraft({ ...draft, reportedModel: event.target.value })} />
                            </label>
                            <label className="space-y-1">
                                服务档位
                                <Input aria-label="契约服务档位" value={draft.serviceTier} placeholder="Standard，如 default" onChange={(event) => setDraft({ ...draft, serviceTier: event.target.value })} />
                            </label>
                            {supportsInclusiveInput && !deepSeekPrice && (
                                <label className="min-w-0 space-y-1">
                                    缓存写入计费方式
                                    <div>
                                        <Select
                                            aria-label="契约缓存写入计费方式"
                                            className="w-full"
                                            value={inclusiveInput ? "included" : "separate"}
                                            options={[
                                                { value: "separate", label: "单独核对缓存写入用量" },
                                                { value: "included", label: "官方已确认缓存写入按普通输入价" },
                                            ]}
                                            onChange={(value) => {
                                                setInclusiveInput(value === "included");
                                                setDraft({ ...draft, itemMeters: Object.fromEntries(priceItems.map((item) => [item.key, []])) });
                                            }}
                                        />
                                    </div>
                                </label>
                            )}
                        </div>
                        {binding && binding.requestedModel !== price.sku && draft.identity && (
                            <div className="space-y-3 rounded-lg border border-amber-300 p-3 dark:border-amber-700">
                                <p className="text-xs text-amber-800 dark:text-amber-200">
                                    渠道请求型号 {binding.requestedModel} 与官网 SKU {price.sku} 不同。须逐渠道审核身份；型号名称相似不能作为依据。
                                </p>
                                <label className="block space-y-1">
                                    响应型号核对方式
                                    <Select
                                        aria-label="渠道别名响应型号策略"
                                        className="w-full"
                                        value={draft.identity.modelIdentity}
                                        options={[
                                            { value: "response-required", label: "响应必须报告已审核型号" },
                                            { value: "reviewed-request", label: "响应未报告时使用已审核请求身份" },
                                        ]}
                                        onChange={(modelIdentity) => setDraft({ ...draft, identity: { ...draft.identity!, modelIdentity } })}
                                    />
                                </label>
                                <label className="block space-y-1">
                                    渠道别名身份来源
                                    <Input aria-label="渠道别名身份来源" value={draft.identity.sourceUrl} placeholder="https://" onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity!, sourceUrl: event.target.value } })} />
                                </label>
                                <label className="block space-y-1">
                                    请求型号与官网 SKU 核对依据
                                    <Input.TextArea aria-label="渠道别名核对依据" value={draft.identity.evidence} rows={2} onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity!, evidence: event.target.value } })} />
                                </label>
                            </div>
                        )}
                        {supportsInclusiveInput && !deepSeekPrice && <p className="text-xs text-zinc-500">只有官网明确写入与普通输入同价时，才选择计入普通输入，并在核对依据中记录来源。切换后需重新绑定全部分项。</p>}
                        {supportsInclusiveInput && (
                            <label className="block space-y-1">
                                官方价档
                                <div>
                                    <Select
                                        aria-label="契约价档"
                                        className="w-full"
                                        value={draft.scope}
                                        options={
                                            deepSeekPrice
                                                ? [{ value: "global-standard-deepseek-utc", label: "DeepSeek UTC 高峰／离峰" }]
                                                : schedule
                                                  ? [{ value: "global-standard-text-tiered", label: "已审核 Standard 价格组" }]
                                                  : [
                                                        { value: "global-standard-text-flat", label: "全上下文单档" },
                                                        { value: "global-standard-text-tiered", label: "按输入总量分短／长上下文" },
                                                    ]
                                        }
                                        onChange={(scope) =>
                                            setDraft({
                                                ...draft,
                                                scope,
                                                contextTiers: scope === "global-standard-text-tiered" && !schedule ? { thresholdInputTokens: 0, shortItemKeys: [], longItemKeys: [], sourceUrl: price.sourceUrl, evidence: "" } : undefined,
                                                itemMeters: defaultMeters(),
                                            })
                                        }
                                    />
                                </div>
                            </label>
                        )}
                        {tiered && tiers && (
                            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p className="text-xs text-zinc-500">阈值按响应中的输入总 Token 判定；超过阈值时整次请求使用长上下文价。每档都要独立覆盖全部计量字段，不能将两档同时计费。</p>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="space-y-1">
                                        输入总 Token 阈值
                                        <Input
                                            aria-label="长上下文输入阈值"
                                            type="number"
                                            min={1}
                                            step={1}
                                            inputMode="numeric"
                                            value={tiers.thresholdInputTokens || ""}
                                            onChange={(event) => setDraft({ ...draft, contextTiers: { ...tiers, thresholdInputTokens: Number(event.target.value) } })}
                                        />
                                    </label>
                                    <label className="space-y-1">
                                        阈值官网来源
                                        <Input aria-label="长上下文阈值来源" value={tiers.sourceUrl} onChange={(event) => setDraft({ ...draft, contextTiers: { ...tiers, sourceUrl: event.target.value } })} />
                                    </label>
                                </div>
                                <label className="block space-y-1">
                                    整次请求适用依据
                                    <Input.TextArea aria-label="长上下文适用依据" rows={2} value={tiers.evidence} onChange={(event) => setDraft({ ...draft, contextTiers: { ...tiers, evidence: event.target.value } })} />
                                </label>
                            </div>
                        )}
                        {schedule && (
                            <p className="text-xs text-zinc-500">
                                官网价已审核 {schedule.groups.filter((group) => group.selector.processingMode === "standard").length} 个 Standard 价格组，按上游响应中的输入总 Token 选择整次请求价档。此处只核对各组共用的计量字段映射。
                            </p>
                        )}
                        <div className="space-y-2">
                            <b>官方分项与实际用量字段</b>
                            {priceItems.map((item) => (
                                <div key={item.key} className="space-y-1 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <span className="break-all">
                                        {item.key}
                                        {!schedule && ` · ${item.price} ${item.currency} / ${item.per} ${item.unit}`}
                                    </span>
                                    {schedule?.groups
                                        .filter((group) => group.selector.processingMode === "standard")
                                        .map((group) => {
                                            const line = group.lines.find((entry) => entry.meter === item.key)!;
                                            const range = group.selector.inputTotalTokens;
                                            return (
                                                <div key={group.id} className="break-all text-xs text-zinc-500">
                                                    {group.id} · {range.minInclusive}–{range.maxInclusive ?? "∞"} 输入 Token · {line.price} USD / {line.per} Token
                                                </div>
                                            );
                                        })}
                                    {tiered && tiers && (
                                        <div>
                                            <Select
                                                aria-label={`${item.key} 所属价档`}
                                                className="w-full"
                                                placeholder="选择短或长上下文价档"
                                                value={tiers.shortItemKeys.includes(item.key) ? "short" : tiers.longItemKeys.includes(item.key) ? "long" : undefined}
                                                options={[
                                                    { value: "short", label: "短上下文" },
                                                    { value: "long", label: "长上下文" },
                                                ]}
                                                onChange={(tier) =>
                                                    setDraft({
                                                        ...draft,
                                                        contextTiers: {
                                                            ...tiers,
                                                            shortItemKeys: [...tiers.shortItemKeys.filter((key) => key !== item.key), ...(tier === "short" ? [item.key] : [])],
                                                            longItemKeys: [...tiers.longItemKeys.filter((key) => key !== item.key), ...(tier === "long" ? [item.key] : [])],
                                                        },
                                                        itemMeters: { ...draft.itemMeters, [item.key]: [] },
                                                    })
                                                }
                                            />
                                        </div>
                                    )}
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {requiredMeters.map((meter) => {
                                            const selected = (draft.itemMeters[item.key] || []).includes(meter);
                                            return (
                                                <Checkbox
                                                    key={meter}
                                                    aria-label={`${item.key} 映射 ${meter}`}
                                                    checked={selected}
                                                    disabled={(tiered && !tiers?.shortItemKeys.includes(item.key) && !tiers?.longItemKeys.includes(item.key)) || (!selected && mappedMetersFor(item.key).includes(meter))}
                                                    onChange={(event) =>
                                                        setDraft({
                                                            ...draft,
                                                            itemMeters: { ...draft.itemMeters, [item.key]: event.target.checked ? [...(draft.itemMeters[item.key] || []), meter] : (draft.itemMeters[item.key] || []).filter((value) => value !== meter) },
                                                        })
                                                    }
                                                >
                                                    {meter === "uncachedInputTokens" ? "未缓存输入（含缓存写入）" : meter}
                                                </Checkbox>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                            <p className="text-xs text-zinc-500">
                                {tiered || deepSeekTiered ? "每个价档" : "本协议"}必须恰好覆盖 {requiredMeters.join("、")}；每个字段在同一档只能计入一个官方分项。不同缓存档位如需不同单价，官方价必须先有对应分项。
                            </p>
                            {!complete && <p className="text-xs text-amber-700 dark:text-amber-300">请确认全部官方分项为 token 单位、用量字段完整且不重复，并填写响应型号、服务档位和证据。</p>}
                        </div>
                        <label className="block space-y-1">
                            核对依据
                            <Input.TextArea aria-label="契约核对依据" rows={3} value={draft.evidence} placeholder="记录官网计费条件、渠道真实响应样本及缓存计价依据" onChange={(event) => setDraft({ ...draft, evidence: event.target.value })} />
                        </label>
                        <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <Checkbox
                                checked={Boolean(limits)}
                                onChange={(event) => setDraft({ ...draft, requestLimits: event.target.checked ? { maxInputTokens: 0, maxOutputTokens: 0, maxCandidates: 0, sourceUrl: "", evidence: "", includesReasoning: true } : undefined })}
                            >
                                核对请求硬上限（含推理 Token）
                            </Checkbox>
                            <p className="text-xs text-zinc-500">这里填写实际执行的硬上限，不是预扣积分。输入包含普通输入与缓存；输出为每个候选的总量，包含推理。填得低于真实上限会使成功调用无法报价；未核实可暂不填写，不能据此启用费用预留。</p>
                            {limits && (
                                <>
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        {(
                                            [
                                                ["maxInputTokens", "输入总量上限"],
                                                ["maxOutputTokens", "单候选输出上限"],
                                                ["maxCandidates", "候选数量上限"],
                                            ] as const
                                        ).map(([key, label]) => (
                                            <label key={key} className="min-w-0 space-y-1">
                                                {label}
                                                <Input
                                                    aria-label={label}
                                                    type="number"
                                                    min={1}
                                                    step={1}
                                                    inputMode="numeric"
                                                    value={limits[key] || ""}
                                                    placeholder="填写已核实上限"
                                                    onChange={(event) => setDraft({ ...draft, requestLimits: { ...limits, [key]: Number(event.target.value) } })}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                    <label className="block space-y-1">
                                        上限官方来源
                                        <Input aria-label="上限官方来源" value={limits.sourceUrl} placeholder="https://" onChange={(event) => setDraft({ ...draft, requestLimits: { ...limits, sourceUrl: event.target.value } })} />
                                    </label>
                                    <label className="block space-y-1">
                                        上限核对依据
                                        <Input.TextArea
                                            aria-label="上限核对依据"
                                            rows={3}
                                            value={limits.evidence}
                                            placeholder="记录型号、输入缓存范围、推理输出范围及渠道执行依据"
                                            onChange={(event) => setDraft({ ...draft, requestLimits: { ...limits, evidence: event.target.value } })}
                                        />
                                    </label>
                                    {!limitsComplete && <p className="text-xs text-amber-700 dark:text-amber-300">请填写三个正整数上限、HTTPS 来源和核对依据。</p>}
                                </>
                            )}
                        </div>
                        <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                            <b>调用前文本预留估算</b>
                            <p className="text-xs text-zinc-500">
                                输入估算采用本次请求内容 JSON 的 UTF-8 字节数；输出参考同型号渠道最近一次实际输出，缺失时按输入估算量与候选数计算，均受已核实请求上界约束。预留按销售版本报价，最终按真实 Token
                                结算差额。请记录该方法适用的样本与异常处理依据。
                            </p>
                            <label className="block space-y-1 text-xs">
                                估算核对来源
                                <Input
                                    aria-label="文本预留估算来源"
                                    value={estimate?.sourceUrl || ""}
                                    placeholder="HTTPS 审核证据地址"
                                    onChange={(event) => setDraft({ ...draft, reservationEstimate: { method: "request-size-recent-output", sourceUrl: event.target.value, evidence: estimate?.evidence || "" } })}
                                />
                            </label>
                            <label className="block space-y-1 text-xs">
                                估算核对记录
                                <Input.TextArea
                                    aria-label="文本预留估算依据"
                                    rows={2}
                                    value={estimate?.evidence || ""}
                                    placeholder="记录请求样本、估算方法、余额不足与补扣处理"
                                    onChange={(event) => setDraft({ ...draft, reservationEstimate: { method: "request-size-recent-output", sourceUrl: estimate?.sourceUrl || "", evidence: event.target.value } })}
                                />
                            </label>
                        </div>
                        <Button type="primary" loading={busy} disabled={!complete} onClick={() => void save()}>
                            审核并保存契约
                        </Button>
                        <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                            <b>审核历史</b>
                            {history.contracts.length ? (
                                history.contracts.map((item) => (
                                    <div key={item.id} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Tag color={item.current ? "green" : "default"}>{item.current ? "当前" : "历史"}</Tag>
                                            <span>
                                                {item.reviewedAt} · {item.reviewedBy}
                                            </span>
                                        </div>
                                        <p className="mt-1 break-all">
                                            {item.protocol} / {item.reportedModel} / {item.serviceTier}
                                        </p>
                                        <p className="mt-1 break-words text-zinc-500">{item.evidence}</p>
                                        {item.identity && (
                                            <p className="mt-1 break-words text-zinc-500">
                                                已核对别名：{item.requestedModel} → {item.identity.officialSku}；{item.identity.modelIdentity}；{item.identity.evidence} · {item.identity.sourceUrl}
                                            </p>
                                        )}
                                        {item.contextTiers && (
                                            <p className="mt-1 break-words text-zinc-500">
                                                长上下文阈值：输入超过 {item.contextTiers.thresholdInputTokens} Token；{item.contextTiers.evidence}
                                            </p>
                                        )}
                                        {item.requestLimits && (
                                            <p className="mt-1 break-words text-zinc-500">
                                                已核实上限：输入 {item.requestLimits.maxInputTokens} / 单候选输出 {item.requestLimits.maxOutputTokens} / 候选 {item.requestLimits.maxCandidates}；{item.requestLimits.evidence}
                                            </p>
                                        )}
                                        {item.reservationEstimate && (
                                            <p className="mt-1 break-words text-zinc-500">
                                                预留估算：{item.reservationEstimate.evidence} · {item.reservationEstimate.sourceUrl}
                                            </p>
                                        )}
                                    </div>
                                ))
                            ) : (
                                <p className="text-xs text-zinc-500">尚无审核记录</p>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Drawer>
    );
}

function AudioContractDrawer({ price, logicalModelId, onClose }: { price: OfficialPriceVersion; logicalModelId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [options, setOptions] = useState<AudioContractOptions>();
    const [bindingKey, setBindingKey] = useState("");
    const [history, setHistory] = useState<AudioContractHistory>();
    const [draft, setDraft] = useState<ReviewedAudioPriceContractInput>();
    const [busy, setBusy] = useState(false);
    const binding = bindingKey ? options?.bindings[Number(bindingKey)] : undefined;
    useEffect(() => {
        let active = true;
        void getAudioContractOptions(price.id, logicalModelId)
            .then((data) => {
                if (!active) return;
                setOptions(data);
                if (data.bindings.length === 1) setBindingKey("0");
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "音频渠道加载失败");
            });
        return () => {
            active = false;
        };
    }, [price.id, logicalModelId, message]);
    useEffect(() => {
        let active = true;
        if (binding)
            void getAudioContractHistory(price.id, binding.channelId, binding.requestedModel)
                .then((data) => {
                    if (!active) return;
                    setHistory(data);
                    const current = data.contracts.find((item) => item.current && item.declaredProtocol === binding.declaredProtocol);
                    setDraft(
                        current ||
                            (binding.declaredProtocol === "openai"
                                ? {
                                      channelId: binding.channelId,
                                      requestedModel: "gpt-audio-1.5",
                                      reportedModel: "gpt-audio-1.5",
                                      declaredProtocol: "openai",
                                      protocol: "openai-chat-audio",
                                      scope: "global-standard-openai-chat-audio-uncached",
                                      itemKeys: { inputTextTokens: "", inputAudioTokens: "", outputTextTokens: "", outputAudioTokens: "" },
                                      evidence: "",
                                  }
                                : {
                                      channelId: binding.channelId,
                                      requestedModel: binding.requestedModel,
                                      reportedModel: binding.requestedModel,
                                      declaredProtocol: binding.declaredProtocol,
                                      protocol: "gemini-tts",
                                      scope: "global-standard-gemini-tts",
                                      modelIdentity: "response-required",
                                      inputTextItem: "",
                                      outputAudioItem: "",
                                      evidence: "",
                                  }),
                    );
                })
                .catch((error) => {
                    if (active) message.error(error instanceof Error ? error.message : "音频契约历史加载失败");
                });
        return () => {
            active = false;
        };
    }, [price.id, binding, message]);
    const fields = !draft
        ? []
        : draft.protocol === "openai-chat-audio"
          ? (
                [
                    ["inputTextTokens", "文本输入 Token"],
                    ["inputAudioTokens", "音频输入 Token"],
                    ["outputTextTokens", "文本输出 Token"],
                    ["outputAudioTokens", "音频输出 Token"],
                ] as const
            ).map(([key, label]) => ({ key, label, value: draft.itemKeys[key], change: (value: string) => setDraft({ ...draft, itemKeys: { ...draft.itemKeys, [key]: value } }) }))
          : (
                [
                    ["inputTextItem", "文本输入 Token"],
                    ["outputAudioItem", "音频输出 Token"],
                ] as const
            ).map(([key, label]) => ({ key, label, value: draft[key], change: (value: string) => setDraft({ ...draft, [key]: value }) }));
    const mapped = fields.map((field) => field.value);
    const complete = Boolean(
        draft &&
        history &&
        draft.evidence.trim() &&
        draft.reportedModel.trim() &&
        mapped.every(Boolean) &&
        new Set(mapped).size === fields.length &&
        price.items.length === fields.length &&
        price.items.every((item) => item.unit === "token" && new Decimal(item.price).gt(0) && mapped.includes(item.key)),
    );
    const itemOptions = (selected: string) =>
        price.items
            .filter((item) => item.unit === "token" && new Decimal(item.price).gt(0))
            .map((item) => ({ value: item.key, label: `${item.key} · ${item.price} ${item.currency} / ${item.per} token`, disabled: item.key !== selected && mapped.includes(item.key) }));
    const save = async () => {
        if (!complete || !draft || !history || !binding || busy) return;
        setBusy(true);
        try {
            await reviewAudioContract(price.id, draft, history.contracts.find((item) => item.current)?.id || null, logicalModelId);
            setHistory(await getAudioContractHistory(price.id, binding.channelId, binding.requestedModel));
            message.success("音频契约已审核留存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "音频契约审核失败");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Drawer
            title="核对音频用量契约"
            width="min(760px, 100vw)"
            styles={{ wrapper: { maxWidth: "100vw" } }}
            open
            onClose={onClose}
            footer={
                <Button type="primary" disabled={!complete} loading={busy} onClick={() => void save()}>
                    审核并保存音频契约
                </Button>
            }
        >
            <div className="space-y-4 text-sm">
                <p className="text-zinc-600 dark:text-zinc-300">核对当前音频协议各分项的全球标准常规单价。官方免费额度不减免用户费用；缺少常规单价继续使用模型固定积分。保存契约不会启用按量扣费。</p>
                <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <b>
                        {price.manufacturer} / {price.sku}
                    </b>
                    <p className="mt-1 break-words">{price.conditions}</p>
                    <a className="mt-1 block break-all text-blue-700 underline dark:text-blue-300" href={price.sourceUrl} target="_blank" rel="noreferrer">
                        查看该版本的官网证据
                    </a>
                </div>
                <label className="block space-y-1">
                    启用的渠道与上游型号
                    <div>
                        <Select
                            aria-label="音频契约渠道绑定"
                            className="w-full"
                            disabled={busy}
                            value={bindingKey || undefined}
                            placeholder="选择已启用绑定"
                            options={options?.bindings.map((item, index) => ({ value: String(index), label: `${item.channelName} / ${item.requestedModel}` })) || []}
                            onChange={(value) => {
                                setDraft(undefined);
                                setHistory(undefined);
                                setBindingKey(value);
                            }}
                        />
                    </div>
                </label>
                {options && !options.bindings.length && <p className="text-amber-700 dark:text-amber-300">没有匹配该官方型号的已启用原生音频绑定。</p>}
                {draft && history && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2" data-testid="audio-contract-grid">
                            {fields.map((field) => (
                                <label key={field.key} className="min-w-0 space-y-1">
                                    {field.label}
                                    <div>
                                        <Select aria-label={`音频 ${field.key} 价项`} className="w-full" disabled={busy} value={field.value || undefined} placeholder="绑定常规计价项目" options={itemOptions(field.value)} onChange={field.change} />
                                    </div>
                                </label>
                            ))}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="min-w-0 space-y-1">
                                响应型号
                                <Input
                                    aria-label="音频响应型号"
                                    disabled={busy || draft.protocol === "openai-chat-audio"}
                                    value={draft.reportedModel}
                                    onChange={(event) => {
                                        if (draft.protocol === "gemini-tts") setDraft({ ...draft, reportedModel: event.target.value });
                                    }}
                                />
                            </label>
                            {draft.protocol === "gemini-tts" ? (
                                <label className="min-w-0 space-y-1">
                                    型号核对方式
                                    <div>
                                        <Select
                                            aria-label="音频型号核对方式"
                                            className="w-full"
                                            disabled={busy}
                                            value={draft.modelIdentity}
                                            options={[
                                                { value: "response-required", label: "必须返回已核对型号" },
                                                { value: "reviewed-request", label: "已核实渠道请求型号" },
                                            ]}
                                            onChange={(modelIdentity) => setDraft({ ...draft, modelIdentity })}
                                        />
                                    </div>
                                </label>
                            ) : (
                                <p className="self-center text-xs text-zinc-500">必须返回上述精确型号和标准档位；缺失时不计算按量费用。</p>
                            )}
                        </div>
                        <p className="text-xs text-zinc-500">
                            协议：{draft.declaredProtocol}。
                            {draft.protocol === "openai-chat-audio"
                                ? "四个计价分项与总量必须明确返回，实际为零的音频输入也必须绑定常规单价；缓存及缓存写入必须明确为零。仅支持同步纯文本输入，文本和音频输出共享请求上界。"
                                : "两个计价分项与总量都必须明确返回；型号未返回仅可使用已核实的渠道请求身份，返回其他型号仍不可报价。"}{" "}
                            缓存、思考、工具及其他模态不属于本契约。
                        </p>
                        <p className="text-xs text-zinc-500">
                            数量上界依照官方型号限制及实际请求参数核对。
                            <a className="text-blue-700 underline dark:text-blue-300" href={options?.requestSourceUrl} target="_blank" rel="noreferrer">
                                查看请求规则
                            </a>
                        </p>
                        <label className="block space-y-1">
                            核对依据
                            <Input.TextArea
                                aria-label="音频契约核对依据"
                                rows={3}
                                disabled={busy}
                                value={draft.evidence}
                                placeholder="记录常规单价、标准档位、真实渠道用量和型号身份依据；不要填写密钥或用户内容"
                                onChange={(event) => setDraft({ ...draft, evidence: event.target.value })}
                            />
                        </label>
                        {!complete && <p className="text-xs text-amber-700 dark:text-amber-300">请完整绑定各分项的非零常规价项，确认响应型号并填写核对依据。</p>}
                        <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800" data-testid="audio-contract-history">
                            <b>审核历史</b>
                            {history.contracts.length ? (
                                history.contracts.map((item) => (
                                    <div key={item.id} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                        <Tag color={item.current ? "green" : "default"}>{item.current ? "当前" : "历史"}</Tag>
                                        <span>{item.reviewedAt}</span>
                                        <p className="mt-1 break-all">
                                            {item.requestedModel} · {item.declaredProtocol}
                                        </p>
                                        <p className="mt-1 break-words text-zinc-500">{item.evidence}</p>
                                    </div>
                                ))
                            ) : (
                                <p className="text-xs text-zinc-500">尚无审核记录</p>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Drawer>
    );
}

function VideoContractDrawer({ price, logicalModelId, onClose }: { price: OfficialPriceVersion; logicalModelId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [options, setOptions] = useState<VideoContractOptions>();
    const [bindingKey, setBindingKey] = useState("");
    const [history, setHistory] = useState<VideoContractHistory>();
    const [draft, setDraft] = useState<ReviewedVideoPriceContractInput>();
    const [busy, setBusy] = useState(false);
    const selection = useRef(bindingKey);
    selection.current = bindingKey;
    const binding = bindingKey ? options?.bindings[Number(bindingKey)] : undefined;
    useEffect(() => {
        let active = true;
        void getVideoContractOptions(price.id, logicalModelId)
            .then((data) => {
                if (!active) return;
                setOptions(data);
                if (data.bindings.length === 1) setBindingKey("0");
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "视频渠道加载失败");
            });
        return () => {
            active = false;
        };
    }, [price.id, logicalModelId, message]);
    useEffect(() => {
        let active = true;
        if (binding && options)
            void getVideoContractHistory(price.id, binding.channelId, binding.requestedModel)
                .then((data) => {
                    if (!active) return;
                    setHistory(data);
                    setDraft(
                        data.contracts.find((item) => item.current) ||
                            (options.protocol === "minimax-hailuo-v1"
                                ? {
                                      channelId: binding.channelId,
                                      requestedModel: binding.requestedModel as HailuoPriceContract["requestedModel"],
                                      protocol: "minimax-hailuo-v1",
                                      scope: "global-standard-minimax-hailuo-generation",
                                      tierItems: { "768P-6": "", "768P-10": "", "1080P-6": "" },
                                      evidence: "",
                                  }
                                : {
                                      channelId: binding.channelId,
                                      requestedModel: binding.requestedModel as VideoPriceContractInput["requestedModel"],
                                      protocol: "minimax-video-v2",
                                      scope: "global-standard-minimax-h3-generation",
                                      resolutionItems: Object.fromEntries(options.resolutions.map((resolution) => [resolution, { inputSeconds: "", outputSeconds: "" }])),
                                      inputImageItem: "",
                                      inputImagePricing: "all-at-standard-rate",
                                      inputAudioItem: "",
                                      evidence: "",
                                  }),
                    );
                })
                .catch((error) => {
                    if (active) message.error(error instanceof Error ? error.message : "视频契约历史加载失败");
                });
        return () => {
            active = false;
        };
    }, [price.id, binding, options, message]);
    const mapped = draft ? (draft.protocol === "minimax-hailuo-v1" ? Object.values(draft.tierItems) : [...Object.values(draft.resolutionItems).flatMap((row) => Object.values(row)), draft.inputImageItem, draft.inputAudioItem]) : [];
    const complete = Boolean(draft && history && draft.evidence.trim() && mapped.every(Boolean) && mapped.length === price.items.length && new Set(mapped).size === price.items.length);
    const itemOptions = (unit: string, selected: string) =>
        price.items
            .filter((item) => item.unit === unit && (unit !== "video" || item.per === "1") && new Decimal(item.price).gt(0))
            .map((item) => ({ value: item.key, label: `${item.key} · ${item.price} ${item.currency} / ${item.per} ${item.unit}`, disabled: item.key !== selected && mapped.includes(item.key) }));
    const save = async () => {
        if (!complete || !draft || !history || !binding || busy) return;
        const key = bindingKey;
        setBusy(true);
        try {
            await reviewVideoContract(price.id, draft, history.contracts.find((item) => item.current)?.id || null, logicalModelId);
            const next = await getVideoContractHistory(price.id, binding.channelId, binding.requestedModel);
            if (selection.current === key) setHistory(next);
            message.success("视频契约已审核留存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频契约审核失败");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Drawer
            title="核对视频用量契约"
            width="min(760px, 100vw)"
            styles={{ wrapper: { maxWidth: "100vw" } }}
            open
            onClose={onClose}
            footer={
                <Button type="primary" disabled={!complete} loading={busy} onClick={() => void save()}>
                    审核并保存视频契约
                </Button>
            }
        >
            <div className="space-y-4 text-sm">
                <p className="text-zinc-600 dark:text-zinc-300">
                    {options?.protocol === "minimax-hailuo-v1"
                        ? "审核 Hailuo 标准生成的三个整段档位；Fast 仅支持单张首帧。原任务完整成功后按冻结档位计一份视频，不使用 H3 秒数分项。"
                        : "审核 H3 标准生成的全部分辨率和素材价项。长期免费的输入音频按零积分处理，视频和图片按常规价收费。"}
                    活动免费额度不减免用户费用。保存契约不会启用按量扣费。
                </p>
                <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <b>
                        {price.manufacturer} / {price.sku}
                    </b>
                    <p className="mt-1 break-words">{price.conditions}</p>
                    <a className="mt-1 block break-all text-blue-700 underline dark:text-blue-300" href={price.sourceUrl} target="_blank" rel="noreferrer">
                        查看该版本的官网证据
                    </a>
                </div>
                <label className="block space-y-1">
                    启用的渠道与上游型号
                    <div>
                        <Select
                            aria-label="视频契约渠道绑定"
                            className="w-full"
                            disabled={busy}
                            value={bindingKey || undefined}
                            placeholder="选择已启用绑定"
                            options={options?.bindings.map((item, index) => ({ value: String(index), label: `${item.channelName} / ${item.requestedModel}` })) || []}
                            onChange={(value) => {
                                setDraft(undefined);
                                setHistory(undefined);
                                setBindingKey(value);
                            }}
                        />
                    </div>
                </label>
                {options && !options.bindings.length && <p className="text-amber-700 dark:text-amber-300">没有匹配该官方型号的已启用 MiniMax 视频绑定。</p>}
                {draft && history && (
                    <>
                        {draft.protocol === "minimax-hailuo-v1" ? (
                            <>
                                <div className="grid gap-3 sm:grid-cols-2" data-testid="video-contract-grid">
                                    {options?.tiers.map((tier) => (
                                        <label key={tier} className="min-w-0 space-y-1">
                                            {tier.replace("-", " · ")} 秒／份
                                            <div>
                                                <Select
                                                    aria-label={`视频 ${tier} 整段价项`}
                                                    className="w-full"
                                                    disabled={busy}
                                                    value={draft.tierItems[tier] || undefined}
                                                    placeholder="绑定每份视频常规单价"
                                                    options={itemOptions("video", draft.tierItems[tier])}
                                                    onChange={(value) => setDraft({ ...draft, tierItems: { ...draft.tierItems, [tier]: value } })}
                                                />
                                            </div>
                                        </label>
                                    ))}
                                </div>
                                <p className="text-xs text-zinc-500">三个档位分别绑定，每项单位必须为一份视频；不重复绑定或借用秒数单价。</p>
                            </>
                        ) : (
                            <>
                                <div className="grid gap-3 sm:grid-cols-2" data-testid="video-contract-grid">
                                    {options?.resolutions.flatMap((resolution) =>
                                        (["inputSeconds", "outputSeconds"] as const).map((meter) => (
                                            <label key={`${resolution}-${meter}`} className="min-w-0 space-y-1">
                                                {resolution} · {meter === "inputSeconds" ? "输入视频秒数" : "输出视频秒数"}
                                                <div>
                                                    <Select
                                                        aria-label={`视频 ${resolution} ${meter} 价项`}
                                                        className="w-full"
                                                        disabled={busy}
                                                        value={draft.resolutionItems[resolution]?.[meter] || undefined}
                                                        placeholder="绑定常规计价项目"
                                                        options={itemOptions("second", draft.resolutionItems[resolution]?.[meter])}
                                                        onChange={(value) => setDraft({ ...draft, resolutionItems: { ...draft.resolutionItems, [resolution]: { ...draft.resolutionItems[resolution], [meter]: value } } })}
                                                    />
                                                </div>
                                            </label>
                                        )),
                                    )}
                                </div>
                                <label className="block space-y-1">
                                    全部实际输入图片
                                    <div>
                                        <Select
                                            aria-label="视频输入图片价项"
                                            className="w-full"
                                            disabled={busy}
                                            value={draft.inputImageItem || undefined}
                                            placeholder="绑定每张常规单价"
                                            options={itemOptions("image", draft.inputImageItem)}
                                            onChange={(inputImageItem) => setDraft({ ...draft, inputImageItem })}
                                        />
                                    </div>
                                </label>
                                <label className="block space-y-1">
                                    官方长期免费输入音频
                                    <div>
                                        <Select
                                            aria-label="视频输入音频零价项"
                                            className="w-full"
                                            disabled={busy}
                                            value={draft.inputAudioItem || undefined}
                                            placeholder="绑定零价秒数分项"
                                            options={price.items
                                                .filter((item) => item.key === "inputAudioSeconds" && item.unit === "second" && item.per === "1" && new Decimal(item.price).isZero())
                                                .map((item) => ({ value: item.key, label: `${item.key} · 官方长期免费` }))}
                                            onChange={(inputAudioItem) => setDraft({ ...draft, inputAudioItem })}
                                        />
                                    </div>
                                </label>
                                <p className="text-xs text-zinc-500">各分辨率的输入与输出分别绑定，全部价项必须覆盖且不得重复。图片按全部实际张数收费。</p>
                            </>
                        )}
                        <p className="text-xs text-zinc-500">
                            数量上界按公开请求契约核对；真实渠道仍需逐项验收。
                            <a className="text-blue-700 underline dark:text-blue-300" href={options?.requestSourceUrl} target="_blank" rel="noreferrer">
                                查看请求规则
                            </a>
                        </p>
                        <label className="block space-y-1">
                            核对依据
                            <Input.TextArea
                                aria-label="视频契约核对依据"
                                rows={3}
                                disabled={busy}
                                value={draft.evidence}
                                placeholder="记录常规价格、实际渠道响应与数量上界依据；不要填写密钥或用户内容"
                                onChange={(event) => setDraft({ ...draft, evidence: event.target.value })}
                            />
                        </label>
                        {!complete && <p className="text-xs text-amber-700 dark:text-amber-300">请完整绑定常规付费价项及官方长期免费音频零价项，并填写核对依据。</p>}
                        <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800" data-testid="video-contract-history">
                            <b>审核历史</b>
                            {history.contracts.length ? (
                                history.contracts.map((item) => (
                                    <div key={item.id} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                        <Tag color={item.current ? "green" : "default"}>{item.current ? "当前" : "历史"}</Tag>
                                        <span>{item.reviewedAt}</span>
                                        <p className="mt-1 break-all">
                                            {item.requestedModel} · {Object.keys(item.protocol === "minimax-hailuo-v1" ? item.tierItems : item.resolutionItems).join(" / ")}
                                        </p>
                                        <p className="mt-1 break-words text-zinc-500">{item.evidence}</p>
                                    </div>
                                ))
                            ) : (
                                <p className="text-xs text-zinc-500">尚无审核记录</p>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Drawer>
    );
}

const emptyImageHoldEstimate = (operation: ImagePriceContractInput["operation"]): NonNullable<ImagePriceContractInput["holdEstimates"]>[number] => ({
    quality: "low",
    size: "",
    ...(operation === "edits" ? { referenceSize: "" } : {}),
    meterQuantities: { inputTextTokens: "", inputImageTokens: "", outputTextTokens: "", outputImageTokens: "" },
    sourceUrl: "",
    evidence: "",
});

function ImageContractDrawer({ price, logicalModelId, onClose }: { price: OfficialPriceVersion; logicalModelId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const perImage = price.items.length === 1 && price.items[0].unit.trim().toLowerCase() === "image";
    const [options, setOptions] = useState<ImageContractOptions>();
    const [bindingKey, setBindingKey] = useState("");
    const [operation, setOperation] = useState<ImagePriceContractInput["operation"]>("generations");
    const [history, setHistory] = useState<ImageContractHistory>();
    const [draft, setDraft] = useState<ImagePriceContractInput>();
    const [busy, setBusy] = useState(false);
    const selection = useRef("");
    const binding = bindingKey ? options?.bindings[Number(bindingKey)] : undefined;
    const alias = Boolean(binding && !price.logicalModelId && binding.requestedModel !== price.sku);
    const selectionKey = JSON.stringify([price.id, bindingKey, operation]);
    selection.current = selectionKey;
    useEffect(() => {
        let active = true;
        void getImageContractOptions(price.id, logicalModelId)
            .then((data) => {
                if (!active) return;
                setOptions(data);
                if (data.bindings.length === 1) setBindingKey("0");
                if (data.bindings[0]?.selectedOperations.length === 1) setOperation(data.bindings[0].selectedOperations[0] as ImagePriceContractInput["operation"]);
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "渠道绑定加载失败");
            });
        return () => {
            active = false;
        };
    }, [price.id, logicalModelId, message]);
    useEffect(() => {
        let active = true;
        if (binding?.selectedOperations.includes(operation))
            void getImageContractHistory(price.id, binding.channelId, binding.requestedModel, operation)
                .then((data) => {
                    if (!active) return;
                    setHistory(data);
                    const current = data.contracts.find((item) => item.current);
                    setDraft(
                        current
                            ? {
                                  ...current,
                                  ...(perImage ? {} : { holdEstimate: undefined, holdEstimates: current.holdEstimates?.length ? current.holdEstimates : [emptyImageHoldEstimate(operation)] }),
                                  ...(alias && current.identity?.channelBindingId !== binding.channelBindingId ? { identity: { channelBindingId: binding.channelBindingId, officialSku: price.sku, operation, sourceUrl: "", evidence: "" } } : {}),
                              }
                            : {
                                  channelId: binding.channelId,
                                  requestedModel: binding.requestedModel,
                                  reportedModel: "",
                                  modelIdentity: "response-required",
                                  ...(alias ? { identity: { channelBindingId: binding.channelBindingId, officialSku: price.sku, operation, sourceUrl: "", evidence: "" } } : {}),
                                  protocol: "openai-images",
                                  operation,
                                  scope: perImage ? "global-standard-dataeyes-flux-image" : "global-standard-direct-image-tokens",
                                  region: "global",
                                  itemMeters: perImage
                                      ? {}
                                      : (Object.fromEntries(price.items.map((item) => [item.key, options?.meters.includes(item.key as ImageContractOptions["meters"][number]) ? [item.key] : []])) as ImagePriceContractInput["itemMeters"]),
                                  zeroMeters: [],
                                  ...(perImage ? {} : { holdEstimates: [emptyImageHoldEstimate(operation)] }),
                                  evidence: "",
                                  ...(perImage ? { imageLimit: { maxImages: 1, sourceUrl: "", evidence: "" } } : {}),
                              },
                    );
                })
                .catch((error) => {
                    if (active) message.error(error instanceof Error ? error.message : "图片契约历史加载失败");
                });
        return () => {
            active = false;
        };
    }, [price.id, price.items, price.logicalModelId, price.sku, binding, operation, perImage, options, message, alias]);
    const mapped = draft ? [...Object.values(draft.itemMeters).flat(), ...draft.zeroMeters] : [];
    const mappingComplete = perImage
        ? binding?.imageCountOperations?.includes(operation) && draft?.imageLimit?.sourceUrl.startsWith("https://") && draft.imageLimit.evidence.trim()
        : price.items.every((item) => item.unit.trim().toLowerCase() === "token" && draft?.itemMeters[item.key]?.length) &&
          mapped.length === options?.meters.length &&
          new Set(mapped).size === options?.meters.length &&
          options?.meters.every((meter) => mapped.includes(meter));
    const estimates = draft?.holdEstimates || [];
    const estimateComplete =
        perImage ||
        Boolean(
            estimates.length &&
            new Set(estimates.map((estimate) => `${estimate.quality}/${estimate.size}/${estimate.referenceSize || ""}`)).size === estimates.length &&
            estimates.every(
                (estimate) =>
                    (estimate.size === "auto"
                        ? Boolean(estimate.observedSize && /^[1-9]\d*x[1-9]\d*$/.test(estimate.observedSize) && estimate.observedSize.split("x").every((part) => Number.isSafeInteger(Number(part))))
                        : /^[1-9]\d*x[1-9]\d*$/.test(estimate.size) && estimate.size.split("x").every((part) => Number.isSafeInteger(Number(part))) && estimate.observedSize === undefined) &&
                    (operation === "edits"
                        ? Boolean(estimate.referenceSize && /^[1-9]\d*x[1-9]\d*$/.test(estimate.referenceSize) && estimate.referenceSize.split("x").every((part) => Number.isSafeInteger(Number(part))) && estimate.meterQuantities.inputImageTokens !== "0")
                        : estimate.referenceSize === undefined) &&
                    estimate.sourceUrl.startsWith("https://") &&
                    estimate.evidence.trim() &&
                    options?.meters.every((meter) => /^(0|[1-9]\d*)$/.test(estimate.meterQuantities[meter]) && Number.isSafeInteger(Number(estimate.meterQuantities[meter]))) &&
                    draft?.zeroMeters.every((meter) => estimate.meterQuantities[meter] === "0") &&
                    options?.meters.some((meter) => !draft?.zeroMeters.includes(meter) && estimate.meterQuantities[meter] !== "0"),
            ),
        );
    const identityComplete =
        !alias ||
        Boolean(
            draft?.identity &&
            draft.identity.channelBindingId === binding?.channelBindingId &&
            draft.identity.officialSku === price.sku &&
            draft.identity.operation === operation &&
            draft.identity.sourceUrl.startsWith("https://") &&
            draft.identity.evidence.trim(),
        );
    const complete = Boolean(binding?.selectedOperations.includes(operation) && draft && history && draft.reportedModel.trim() && draft.evidence.trim() && price.items.length && mappingComplete && estimateComplete && identityComplete);
    const save = async () => {
        if (!draft || !binding || !history || !complete) return;
        const key = selectionKey;
        setBusy(true);
        try {
            await reviewImageContract(price.id, draft, history.contracts.find((item) => item.current)?.id || null, logicalModelId);
            const next = await getImageContractHistory(price.id, binding.channelId, binding.requestedModel, operation);
            if (selection.current === key) setHistory(next);
            message.success("图片契约已审核留存；尚未启用真实扣费");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片契约审核失败");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Drawer title="核对图片用量契约" width="min(760px, 100vw)" styles={{ wrapper: { maxWidth: "100vw" } }} open onClose={onClose}>
            <div className="space-y-4 text-sm">
                <p className="text-zinc-600 dark:text-zinc-300">
                    {perImage ? "核对已支持渠道的全球标准按张单档及每请求一张的上界。" : "核对直接 Images API 的全球标准 Token 单档。"}创建与编辑分别审核，不适用于工具、缓存优惠或其他条件档位。当前固定积分不变。
                </p>
                <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                    <b>
                        {price.manufacturer} / {price.officialVersion}
                    </b>
                    <p className="mt-1 break-words">{price.conditions}</p>
                    <a className="mt-1 block break-all text-blue-700 underline dark:text-blue-300" href={price.sourceUrl} target="_blank" rel="noreferrer">
                        查看该版本的官网证据
                    </a>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="min-w-0 space-y-1">
                        启用的渠道与上游型号
                        <div>
                            <Select
                                aria-label="图片契约渠道绑定"
                                className="w-full"
                                disabled={busy}
                                value={bindingKey || undefined}
                                placeholder="选择已启用绑定"
                                options={options?.bindings.map((item, index) => ({ value: String(index), label: `${item.channelName} / ${item.requestedModel}` })) || []}
                                onChange={(value) => {
                                    setHistory(undefined);
                                    setDraft(undefined);
                                    setBindingKey(value);
                                    const selected = options?.bindings[Number(value)];
                                    if (selected && !selected.selectedOperations.includes(operation)) setOperation(selected.selectedOperations[0] as ImagePriceContractInput["operation"]);
                                }}
                            />
                        </div>
                    </label>
                    <label className="min-w-0 space-y-1">
                        图片操作
                        <div>
                            <Select
                                aria-label="图片契约操作"
                                className="w-full"
                                disabled={busy}
                                value={operation}
                                options={[
                                    { value: "generations", label: "创建（generations）" },
                                    { value: "edits", label: "编辑（edits）" },
                                ].filter((item) => !binding || binding.selectedOperations.includes(item.value))}
                                onChange={(value) => {
                                    setHistory(undefined);
                                    setDraft(undefined);
                                    setOperation(value);
                                }}
                            />
                        </div>
                    </label>
                </div>
                {options && !options.bindings.length && <p className="text-amber-700 dark:text-amber-300">该图片逻辑模型暂无已启用的渠道绑定。</p>}
                {draft && history && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="min-w-0 space-y-1">
                                响应型号校验
                                <div>
                                    <Select
                                        aria-label="图片契约型号依据"
                                        className="w-full"
                                        value={draft.modelIdentity}
                                        options={[
                                            { value: "response-required", label: "响应必须报告型号" },
                                            { value: "reviewed-request", label: "已核对请求型号，可缺响应型号" },
                                        ]}
                                        onChange={(modelIdentity) => setDraft({ ...draft, modelIdentity })}
                                    />
                                </div>
                            </label>
                            <label className="min-w-0 space-y-1">
                                预期响应型号
                                <Input aria-label="图片契约响应型号" value={draft.reportedModel} onChange={(event) => setDraft({ ...draft, reportedModel: event.target.value })} />
                            </label>
                        </div>
                        <p className="text-xs text-zinc-500">允许缺少响应型号时，必须在依据中说明请求型号与官方 SKU 的核对证据。上游只要返回型号，就必须与预期一致。</p>
                        {alias && draft.identity && (
                            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p>
                                    渠道型号身份：{binding?.requestedModel} → {price.sku} · {operation}
                                </p>
                                <label className="block space-y-1">
                                    别名身份来源
                                    <Input aria-label="图片渠道别名身份来源" value={draft.identity.sourceUrl} placeholder="https://" onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity!, sourceUrl: event.target.value } })} />
                                </label>
                                <label className="block space-y-1">
                                    别名核对依据
                                    <Input.TextArea aria-label="图片渠道别名核对依据" value={draft.identity.evidence} rows={2} onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity!, evidence: event.target.value } })} />
                                </label>
                            </div>
                        )}
                        {!perImage && (
                            <>
                                {price.items.map((item) => (
                                    <div key={item.key} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                        <p className="break-all">
                                            {item.key} · {item.price} {item.currency} / {item.per} {item.unit}
                                        </p>
                                        <div className="grid gap-2 sm:grid-cols-2">
                                            {options?.meters.map((meter) => {
                                                const selected = draft.itemMeters[item.key]?.includes(meter);
                                                return (
                                                    <Checkbox
                                                        key={meter}
                                                        aria-label={`图片 ${item.key} 映射 ${meter}`}
                                                        checked={selected}
                                                        disabled={!selected && mapped.includes(meter)}
                                                        onChange={(event) =>
                                                            setDraft({
                                                                ...draft,
                                                                itemMeters: { ...draft.itemMeters, [item.key]: event.target.checked ? [...(draft.itemMeters[item.key] || []), meter] : draft.itemMeters[item.key].filter((value) => value !== meter) },
                                                            })
                                                        }
                                                    >
                                                        {meter}
                                                    </Checkbox>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                                <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <b>必须明确为零的分项</b>
                                    <p className="text-xs text-zinc-500">这些字段必须在真实响应中存在且为 0。缺失或非零都不能报价，不会按零补齐未知用量。</p>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {options?.meters.map((meter) => {
                                            const selected = draft.zeroMeters.includes(meter);
                                            return (
                                                <Checkbox
                                                    key={meter}
                                                    aria-label={`图片必须为零 ${meter}`}
                                                    checked={selected}
                                                    disabled={!selected && mapped.includes(meter)}
                                                    onChange={(event) => setDraft({ ...draft, zeroMeters: event.target.checked ? [...draft.zeroMeters, meter] : draft.zeroMeters.filter((value) => value !== meter) })}
                                                >
                                                    {meter}
                                                </Checkbox>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                    <b>按画质和尺寸的 Token 预留估算</b>
                                    <p className="text-xs text-zinc-500">
                                        按明确画质及已审核的固定尺寸或 auto 样本预留；auto 须记录样本实际输出尺寸，编辑另须审核单张参考图尺寸。未审核组合、蒙版及多参考图继续暂停。估算不是用量上界，实际扣费按真实 Token 结算。
                                    </p>
                                    {estimates.map((estimate, index) => {
                                        const update = (patch: Partial<typeof estimate>) => setDraft({ ...draft, holdEstimates: estimates.map((item, offset) => (offset === index ? { ...item, ...patch } : item)) });
                                        return (
                                            <div key={index} className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                                <div className="grid gap-2 sm:grid-cols-2">
                                                    <label className="space-y-1 text-xs">
                                                        画质
                                                        <Select
                                                            aria-label={`图片预留档位 ${index + 1} 画质`}
                                                            value={estimate.quality}
                                                            options={(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(price.sku) ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"]).map((value) => ({ value, label: value }))}
                                                            onChange={(quality) => update({ quality })}
                                                            className="w-full"
                                                        />
                                                    </label>
                                                    <label className="space-y-1 text-xs">
                                                        请求尺寸
                                                        <Input
                                                            aria-label={`图片预留档位 ${index + 1} 尺寸`}
                                                            value={estimate.size}
                                                            onChange={(event) => update({ size: event.target.value, observedSize: event.target.value === "auto" ? estimate.observedSize || "" : undefined })}
                                                            placeholder="1024x1024 或 auto"
                                                        />
                                                    </label>
                                                    {estimate.size === "auto" && (
                                                        <label className="space-y-1 text-xs">
                                                            样本实际输出尺寸
                                                            <Input aria-label={`图片预留档位 ${index + 1} 样本输出尺寸`} value={estimate.observedSize || ""} onChange={(event) => update({ observedSize: event.target.value })} placeholder="1536x1024" />
                                                        </label>
                                                    )}
                                                    {operation === "edits" && (
                                                        <label className="space-y-1 text-xs">
                                                            单张参考图尺寸
                                                            <Input aria-label={`图片预留档位 ${index + 1} 参考图尺寸`} value={estimate.referenceSize || ""} onChange={(event) => update({ referenceSize: event.target.value })} placeholder="1024x1024" />
                                                        </label>
                                                    )}
                                                </div>
                                                <div className="grid gap-2 sm:grid-cols-2">
                                                    {options?.meters.map((meter) => (
                                                        <label key={meter} className="min-w-0 space-y-1 text-xs">
                                                            {meter}
                                                            <Input
                                                                aria-label={`图片预留档位 ${index + 1} ${meter}`}
                                                                value={estimate.meterQuantities[meter]}
                                                                onChange={(event) => update({ meterQuantities: { ...estimate.meterQuantities, [meter]: event.target.value } })}
                                                                placeholder="非负整数"
                                                            />
                                                        </label>
                                                    ))}
                                                </div>
                                                <label className="block space-y-1 text-xs">
                                                    依据来源
                                                    <Input aria-label={`图片预留档位 ${index + 1} 来源`} value={estimate.sourceUrl} onChange={(event) => update({ sourceUrl: event.target.value })} placeholder="HTTPS 文档或审核证据地址" />
                                                </label>
                                                <label className="block space-y-1 text-xs">
                                                    核对记录
                                                    <Input.TextArea aria-label={`图片预留档位 ${index + 1} 依据`} rows={2} value={estimate.evidence} onChange={(event) => update({ evidence: event.target.value })} placeholder="说明同档样本与估算方法" />
                                                </label>
                                                <Button onClick={() => setDraft({ ...draft, holdEstimates: estimates.filter((_, offset) => offset !== index) })}>移除档位</Button>
                                            </div>
                                        );
                                    })}
                                    <Button onClick={() => setDraft({ ...draft, holdEstimates: [...estimates, emptyImageHoldEstimate(operation)] })}>添加档位</Button>
                                </div>
                            </>
                        )}
                        {perImage && draft.imageLimit && (
                            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                <p>
                                    按实际成功图片计量 · {price.items[0].price} {price.items[0].currency} / {price.items[0].per} 张
                                </p>
                                <p className="text-xs text-zinc-500">DataEyes FLUX 单请求上界：1 张。n 不改变张数；失败或数量不符不报价。此处不补填 Token。</p>
                                {!binding?.imageCountOperations?.includes(operation) && <p className="text-xs text-amber-700 dark:text-amber-300">当前渠道、型号或操作尚不支持按张审核。</p>}
                                <label className="block space-y-1">
                                    上界来源
                                    <Input
                                        aria-label="图片按张上界来源"
                                        value={draft.imageLimit.sourceUrl}
                                        onChange={(event) => setDraft({ ...draft, imageLimit: { ...draft.imageLimit!, sourceUrl: event.target.value } })}
                                        placeholder="HTTPS 渠道文档地址"
                                    />
                                </label>
                                <label className="block space-y-1">
                                    上界核对记录
                                    <Input.TextArea
                                        aria-label="图片按张上界依据"
                                        rows={2}
                                        value={draft.imageLimit.evidence}
                                        onChange={(event) => setDraft({ ...draft, imageLimit: { ...draft.imageLimit!, evidence: event.target.value } })}
                                        placeholder="记录每请求张数、适用操作与实际渠道样本"
                                    />
                                </label>
                            </div>
                        )}
                        <label className="block space-y-1">
                            核对依据
                            <Input.TextArea
                                aria-label="图片契约核对依据"
                                rows={3}
                                value={draft.evidence}
                                placeholder="记录官网分项、全部尺寸与画质适用条件、型号映射及该操作的真实渠道响应；不要填写密钥或用户内容"
                                onChange={(event) => setDraft({ ...draft, evidence: event.target.value })}
                            />
                        </label>
                        {!complete && (
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                                {perImage ? "请选择支持按张计价的绑定和操作，补齐型号、上界来源及核对依据。" : "请完整且不重复地绑定四个模态分项，填写型号、预留估算和核对依据。全部官方价格项都必须适用。"}
                            </p>
                        )}
                        <Button type="primary" disabled={!complete} loading={busy} onClick={() => void save()}>
                            审核并保存图片契约
                        </Button>
                        <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                            <b>审核历史</b>
                            {history.contracts.length ? (
                                history.contracts.map((item) => (
                                    <div key={item.id} className="rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-800">
                                        <Tag color={item.current ? "green" : "default"}>{item.current ? "当前" : "历史"}</Tag>
                                        <span>{item.reviewedAt}</span>
                                        <p className="mt-1 break-all">
                                            {item.operation} / {item.reportedModel} / {item.modelIdentity} / {item.scope === "global-standard-dataeyes-flux-image" ? "按张" : "Token"}
                                        </p>
                                        <p className="mt-1 break-words text-zinc-500">{item.evidence}</p>
                                        {item.identity && (
                                            <p className="mt-1 break-all text-zinc-500">
                                                已核对别名：{item.requestedModel} → {item.identity.officialSku} · {item.identity.operation} · {item.identity.evidence} · {item.identity.sourceUrl}
                                            </p>
                                        )}
                                        {item.imageLimit && (
                                            <p className="mt-1 break-all text-zinc-500">
                                                每请求上界 {item.imageLimit.maxImages} 张 · {item.imageLimit.sourceUrl} · {item.imageLimit.evidence}
                                            </p>
                                        )}
                                        {item.holdEstimate && (
                                            <p className="mt-1 break-all text-zinc-500">
                                                预留估算：{options?.meters.map((meter) => `${meter} ${item.holdEstimate?.meterQuantities[meter]}`).join(" · ")} · {item.holdEstimate.sourceUrl} · {item.holdEstimate.evidence}
                                            </p>
                                        )}
                                        {item.holdEstimates?.map((estimate) => (
                                            <p key={`${estimate.quality}/${estimate.size}/${estimate.referenceSize || ""}`} className="mt-1 break-all text-zinc-500">
                                                预留档位 {estimate.quality} / {estimate.size}
                                                {estimate.observedSize ? ` / 样本输出 ${estimate.observedSize}` : ""}
                                                {estimate.referenceSize ? ` / 参考图 ${estimate.referenceSize}` : ""}：{options?.meters.map((meter) => `${meter} ${estimate.meterQuantities[meter]}`).join(" · ")} · {estimate.sourceUrl} · {estimate.evidence}
                                            </p>
                                        ))}
                                    </div>
                                ))
                            ) : (
                                <p className="text-xs text-zinc-500">此操作尚无审核记录</p>
                            )}
                        </div>
                    </>
                )}
            </div>
        </Drawer>
    );
}
