"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "antd";
import { ArrowRight, Clapperboard, GalleryVerticalEnd, Image as ImageIcon, ImageOff, Play, RotateCw, Video } from "lucide-react";

import { LazyMediaImage } from "@/components/media/lazy-media-image";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { listPublicGallery, type PublicGalleryItem } from "@/services/api/work-governance";
import { HOME_GALLERY_TABS, homeGalleryMatches, type HomeGalleryTab } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeGallery() {
    const [tab, setTab] = useState<HomeGalleryTab>("all");
    const [previewItem, setPreviewItem] = useState<PublicGalleryItem>();
    const { startCreating, openProtectedPath } = useHomeActions();
    const query = useQuery({
        queryKey: ["home-public-gallery", "random"],
        queryFn: () => listPublicGallery({ limit: 18, sort: "random" }),
        staleTime: 60_000,
    });
    const items = (query.data?.items || []).filter((item) => homeGalleryMatches(item, tab));

    return (
        <section id="inspiration" className={styles.section} aria-labelledby="home-gallery-title">
            <header className={styles.sectionHeading}>
                <h2 id="home-gallery-title">灵感作品展示</h2>
                <p>探索创作者的优秀作品，激发你的创作灵感</p>
            </header>

            <div className={styles.galleryTabs} role="tablist" aria-label="作品分类">
                {HOME_GALLERY_TABS.map((item) => (
                    <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls="home-gallery-panel" className={tab === item.id ? styles.galleryTabActive : undefined} onClick={() => setTab(item.id)}>
                        {item.label}
                    </button>
                ))}
            </div>

            <div id="home-gallery-panel" role="tabpanel" className={styles.galleryPanel}>
                {query.isLoading ? (
                    <div className={styles.galleryGrid} aria-label="正在加载公开作品">
                        {Array.from({ length: 8 }, (_, index) => (
                            <GallerySkeleton key={index} />
                        ))}
                    </div>
                ) : query.isError ? (
                    <GalleryState
                        icon={<RotateCw aria-hidden="true" />}
                        title="作品暂时无法加载"
                        description="请稍后重试，或刷新页面后再试。"
                        action={
                            <button type="button" onClick={() => void query.refetch()}>
                                重新加载
                            </button>
                        }
                    />
                ) : items.length ? (
                    <div className={styles.galleryGrid} data-testid="home-public-gallery">
                        {items.map((item) => (
                            <HomeWorkCard key={item.slug} item={item} onPreview={() => setPreviewItem(item)} />
                        ))}
                    </div>
                ) : (
                    <GalleryState
                        icon={<GalleryVerticalEnd aria-hidden="true" />}
                        title={tab === "all" ? "从一个想法开始" : "该分类暂无公开作品"}
                        description={tab === "all" ? "这里会展示公开作品。你也可以先创建自己的第一件作品。" : "切换其他分类，或直接开始一次新的创作。"}
                        action={
                            tab === "all" ? (
                                <div className={styles.galleryStateActions}>
                                    <button type="button" onClick={() => startCreating("生成一张适合分享的作品", "image")}>
                                        <ImageIcon aria-hidden="true" /> 生成图片
                                    </button>
                                    <button type="button" onClick={() => startCreating("制作一段适合分享的短视频", "video")}>
                                        <Video aria-hidden="true" /> 制作视频
                                    </button>
                                    <button type="button" onClick={() => openProtectedPath("/drama")}>
                                        <Clapperboard aria-hidden="true" /> 开始短剧
                                    </button>
                                </div>
                            ) : undefined
                        }
                    />
                )}
            </div>

            <div className={styles.galleryMore}>
                <Link href="/gallery">
                    查看更多作品 <ArrowRight aria-hidden="true" />
                </Link>
            </div>
            <HomeMediaPreview item={previewItem} onClose={() => setPreviewItem(undefined)} />
        </section>
    );
}

function HomeWorkCard({ item, onPreview }: { item: PublicGalleryItem; onPreview: () => void }) {
    const [mediaFailed, setMediaFailed] = useState(false);
    const [duration, setDuration] = useState(0);
    const preview = item.preview;

    return (
        <article className={styles.workCard} data-testid="home-gallery-card">
            <button type="button" className={styles.workMedia} aria-label={`查看作品：${item.title}`} onClick={onPreview}>
                {mediaFailed || !preview || (preview.mediaType !== "image" && preview.mediaType !== "video") ? (
                    <span className={styles.mediaFallback} role="img" aria-label="作品预览不可用">
                        <ImageOff aria-hidden="true" />
                        <span>预览不可用</span>
                    </span>
                ) : preview.mediaType === "image" ? (
                    <LazyMediaImage src={imagePreviewUrl(preview.url, 640)} alt={item.title} containerClassName={styles.workImageWrap} imageClassName={styles.workImage} errorLabel="作品图片不可用" />
                ) : (
                    <video src={preview.url} muted playsInline preload="metadata" className={styles.workImage} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onError={() => setMediaFailed(true)} />
                )}
                {preview?.mediaType === "video" ? (
                    <span className={styles.playIcon}>
                        <Play aria-hidden="true" fill="currentColor" />
                    </span>
                ) : null}
                {preview?.mediaType === "video" && duration > 0 ? <span className={styles.duration}>{formatDuration(duration)}</span> : null}
                <span className={styles.workBody} data-gallery-work-body>
                    <span className={styles.workTitle}>{item.title}</span>
                </span>
            </button>
        </article>
    );
}

function HomeMediaPreview({ item, onClose }: { item?: PublicGalleryItem; onClose: () => void }) {
    const preview = item?.preview;
    const supported = preview?.mediaType === "image" || preview?.mediaType === "video";
    return (
        <Modal
            open={Boolean(item && supported)}
            onCancel={onClose}
            footer={null}
            centered
            width="auto"
            destroyOnHidden
            title={null}
            styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "88dvh" } }}
        >
            {item && preview?.mediaType === "image" ? <img src={imagePreviewUrl(preview.url, 1920)} alt={item.title} className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain" /> : null}
            {item && preview?.mediaType === "video" ? <video src={preview.url} aria-label={item.title} className="block max-h-[88dvh] max-w-[min(92vw,1440px)] object-contain" controls autoPlay playsInline /> : null}
        </Modal>
    );
}

function GallerySkeleton() {
    return (
        <div className={styles.gallerySkeleton}>
            <span />
            <i />
            <i />
        </div>
    );
}

function GalleryState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
    return (
        <div className={styles.galleryState}>
            <span>{icon}</span>
            <h3>{title}</h3>
            <p>{description}</p>
            {action}
        </div>
    );
}

function formatDuration(seconds: number) {
    const safe = Math.max(0, Math.round(seconds));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
