import { after, NextResponse } from "next/server";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { createDramaRenderTask, getDramaRenderTask, touchDramaRenderTask, transitionDramaRenderTask, type DramaRenderTask } from "@/lib/server/drama-render-store";
import { resolveDramaRenderAudioPlan } from "@/lib/server/drama-render-audio";
import { normalizeDramaRenderShots, type NormalizedDramaRenderShot } from "@/lib/server/drama-render-input";
import { ffmpegAvailable, runFfmpeg, runFfprobe } from "@/lib/server/ffmpeg";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { writeReferenceMediaFile } from "@/lib/server/reference-asset-store";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { dramaOutputDimensions, normalizeDramaImageSize } from "@/lib/drama-image-size";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.workflow.run", user.id);
    if (blocked) return blocked;
    const rate = await checkGenerationRateLimit(user.id, request, "render");
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "成片合成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const renderLimit = (await getAuthSettings()).generationConcurrency.render;
    const response = await withGenerationConcurrencyLimit(user.id, "render", 60 * 60_000, renderLimit, async () => {
        if (!(await ffmpegAvailable())) return NextResponse.json({ code: 503, data: null, msg: "当前服务器未安装 FFmpeg" }, { status: 503 });
        let body: { projectId?: unknown; conversationId?: unknown; title?: unknown; ratio?: unknown; shots?: unknown[] };
        try {
            body = await readJsonBody(request);
        } catch (error) {
            if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
            throw error;
        }
        const projectId = text(body.projectId);
        const title = text(body.title) || "短剧成片";
        const shots = normalizeDramaRenderShots(body.shots);
        if (!projectId || !shots.length || shots.some((shot) => !shot.videoUrl)) return NextResponse.json({ code: 400, data: null, msg: "请先完成全部镜头视频" }, { status: 400 });
        if (shots.some((shot) => shot.audioMode === "voiceover" && !shot.audioUrl)) return NextResponse.json({ code: 400, data: null, msg: "部分镜头选择了 AI 配音，但配音尚未完成" }, { status: 400 });
        const size = normalizeDramaImageSize(body.ratio);
        if (!size) return NextResponse.json({ code: 400, data: null, msg: "短剧尺寸无效" }, { status: 400 });
        const task = await createDramaRenderTask({ userId: user.id, projectId, conversationId: text(body.conversationId) || undefined, title });
        after(() => renderDrama(task, shots, size, resolveInternalOrigin(new URL(request.url).origin), request.headers.get("cookie") || ""));
        return NextResponse.json({ code: 0, data: publicTask(task), msg: "合成任务已创建" });
    });
    return response || NextResponse.json({ code: 429, data: null, msg: `当前最多同时运行 ${renderLimit} 个整集合成任务` }, { status: 429 });
}

async function renderDrama(task: DramaRenderTask, shots: NormalizedDramaRenderShot[], sizeValue: string, origin: string, cookie: string) {
    const running = await transitionDramaRenderTask(task, ["pending"], { status: "running" });
    if (!running) return;
    const workdir = await mkdtemp(join(tmpdir(), "vozeb-pro-drama-"));
    const heartbeat = setInterval(() => {
        void touchDramaRenderTask(task.id);
    }, 60_000);
    const abortController = new AbortController();
    let cancellationCheckRunning = false;
    const cancellationMonitor = setInterval(() => {
        if (cancellationCheckRunning || abortController.signal.aborted) return;
        cancellationCheckRunning = true;
        void getDramaRenderTask(task.id)
            .then((latest) => {
                if (latest?.status === "cancelled") abortController.abort();
            })
            .finally(() => {
                cancellationCheckRunning = false;
            });
    }, 1000);
    try {
        const size = dramaOutputDimensions(sizeValue);
        const clipPaths: string[] = [];
        for (let index = 0; index < shots.length; index += 1) {
            if ((await getDramaRenderTask(task.id))?.status === "cancelled") return;
            const current = shots[index];
            const videoPath = join(workdir, `source-${index}.mp4`);
            await downloadMedia(current.videoUrl, videoPath, origin, cookie, 300 * 1024 * 1024);
            const clipPath = join(workdir, `clip-${index}.mp4`);
            const baseArgs = ["-y", "-i", videoPath];
            const audioPlan = resolveDramaRenderAudioPlan(current.audioMode, current.audioUrl, current.audioMode === "source" ? await hasAudioStream(videoPath, workdir, abortController.signal) : false);
            if (audioPlan === "voiceover") {
                const audioPath = join(workdir, `audio-${index}.mp3`);
                await downloadMedia(current.audioUrl, audioPath, origin, cookie, 30 * 1024 * 1024);
                baseArgs.push(
                    "-i",
                    audioPath,
                    "-filter_complex",
                    `[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${current.duration},trim=0:${current.duration}[v];[1:a]apad,atrim=0:${current.duration}[a]`,
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                );
            } else if (audioPlan === "source") {
                baseArgs.push(
                    "-filter_complex",
                    `[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${current.duration},trim=0:${current.duration}[v];[0:a]aresample=async=1:first_pts=0,apad,atrim=0:${current.duration}[a]`,
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                );
            } else {
                baseArgs.push(
                    "-f",
                    "lavfi",
                    "-t",
                    String(current.duration),
                    "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=44100",
                    "-filter_complex",
                    `[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${current.duration},trim=0:${current.duration}[v]`,
                    "-map",
                    "[v]",
                    "-map",
                    "1:a",
                );
            }
            baseArgs.push("-t", String(current.duration), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", clipPath);
            await runFfmpeg(baseArgs, { cwd: workdir, signal: abortController.signal });
            clipPaths.push(clipPath);
        }
        await writeFile(join(workdir, "concat.txt"), clipPaths.map((_, index) => `file 'clip-${index}.mp4'`).join("\n"), "utf8");
        const joinedPath = join(workdir, "joined.mp4");
        await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", joinedPath], { cwd: workdir, signal: abortController.signal });
        const srt = buildServerSrt(shots);
        const outputPath = join(workdir, "output.mp4");
        if (srt) {
            await writeFile(join(workdir, "subtitles.srt"), `\uFEFF${srt}`, "utf8");
            await runFfmpeg(
                [
                    "-y",
                    "-i",
                    joinedPath,
                    "-vf",
                    "subtitles=subtitles.srt:force_style='FontName=Noto Sans CJK SC,FontSize=18,Outline=2,Shadow=1,MarginV=36'",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "22",
                    "-c:a",
                    "copy",
                    "-movflags",
                    "+faststart",
                    outputPath,
                ],
                { cwd: workdir, signal: abortController.signal },
            );
        } else {
            await runFfmpeg(["-y", "-i", joinedPath, "-c", "copy", outputPath], { cwd: workdir, signal: abortController.signal });
        }
        const asset = await writeReferenceMediaFile(outputPath, "video", "video/mp4", true, {
            ownerUserId: task.userId,
            source: "drama-render",
            conversationId: task.conversationId,
            taskId: task.id,
            projectId: task.projectId,
            originalName: `${task.title}.mp4`,
        });
        const completed = await transitionDramaRenderTask(task, ["running"], { status: "success", result: { url: asset.url || `/api/reference-assets/${asset.token}`, mimeType: "video/mp4" }, error: undefined });
        if (completed?.result)
            await registerGenerationTaskAssetsForUser(task.userId, {
                ...completed,
                taskId: task.id,
                title: task.title,
                assets: [{ type: "video", url: completed.result.url, mimeType: completed.result.mimeType }],
            }).catch((error) => console.error("Creative render asset registration failed", error));
    } catch (error) {
        await transitionDramaRenderTask(task, ["running"], { status: "error", error: error instanceof Error ? error.message : "整集合成失败" });
    } finally {
        clearInterval(heartbeat);
        clearInterval(cancellationMonitor);
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function hasAudioStream(videoPath: string, cwd: string, signal: AbortSignal) {
    const result = await runFfprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1", videoPath], { cwd, signal, timeoutMs: 30_000 });
    return result.stdout.trim() === "audio";
}
async function downloadMedia(url: string, path: string, origin: string, cookie: string, maxBytes: number) {
    const internal = url.startsWith("/");
    const target = internal ? `${origin}${url}` : url;
    const response = internal ? await fetchInternalApi(target, { headers: cookie ? { cookie } : undefined, signal: AbortSignal.timeout(3 * 60_000) }) : await fetchExternalMedia(target);
    if (!response.ok) throw new Error(`媒体下载失败（${response.status}）`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("媒体文件超过大小限制");
    if (!response.body) throw new Error("媒体文件为空");
    const file = await open(path, "w");
    let bytes = 0;
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                throw new Error("媒体文件超过大小限制");
            }
            await file.write(value);
        }
    } finally {
        await file.close();
    }
    if (!bytes) throw new Error("媒体文件为空");
}
async function fetchExternalMedia(initialUrl: string) {
    let target = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await fetchSafeOutbound(target, { redirect: "manual", signal: AbortSignal.timeout(3 * 60_000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) throw new Error("媒体重定向地址无效");
        target = new URL(location, target).toString();
    }
    throw new Error("媒体重定向次数过多");
}
function buildServerSrt(shots: NormalizedDramaRenderShot[]) {
    let cursor = 0;
    let index = 0;
    return shots
        .flatMap((shot) => {
            const start = cursor;
            cursor += shot.duration * 1000;
            if (!shot.subtitle) return [];
            index += 1;
            return [`${index}\n${srtTime(start)} --> ${srtTime(cursor)}\n${shot.subtitle}`];
        })
        .join("\n\n");
}
function srtTime(ms: number) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
function publicTask(task: DramaRenderTask) {
    return { id: task.id, status: task.status, result: task.result, error: task.error };
}
