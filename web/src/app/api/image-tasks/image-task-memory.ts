import { getHeapStatistics } from "node:v8";

import type { ImageTaskReference } from "@/lib/server/image-task-store";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { getLocalMediaRegistrations } from "@/lib/server/local-media-registry";

import { rawReferenceRequestUrlCandidates } from "./image-task-reference-urls";
import { MAX_INLINE_IMAGE_BYTES } from "./image-task-types";

type WeightedImageSubmissionQueue = {
    run: <T>(weight: number, operation: () => Promise<T>) => Promise<T>;
};

type WaitingSubmission = {
    weight: number;
    start: () => void;
};

type ImageSubmissionSources = {
    userId: string;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
};

const NATIVE_SUB2API_MEMORY_MULTIPLIER = 6;
const NATIVE_SUB2API_MEMORY_CAPACITY = Math.max(1, Math.floor(getHeapStatistics().heap_size_limit / 2));
const nativeSub2ApiSubmissionQueue = createWeightedImageSubmissionQueue(NATIVE_SUB2API_MEMORY_CAPACITY);

export function createWeightedImageSubmissionQueue(capacity: number): WeightedImageSubmissionQueue {
    const maximumWeight = Math.max(1, Math.floor(capacity));
    const waiting: WaitingSubmission[] = [];
    let activeWeight = 0;

    const startWaitingSubmissions = () => {
        while (waiting.length) {
            const next = waiting[0];
            if (activeWeight + next.weight > maximumWeight) break;
            waiting.shift();
            activeWeight += next.weight;
            next.start();
        }
    };

    return {
        async run<T>(weight: number, operation: () => Promise<T>) {
            const reservedWeight = Math.min(maximumWeight, Math.max(1, Math.ceil(Number.isFinite(weight) ? weight : maximumWeight)));
            await new Promise<void>((resolve) => {
                waiting.push({ weight: reservedWeight, start: resolve });
                startWaitingSubmissions();
            });
            try {
                return await operation();
            } finally {
                activeWeight -= reservedWeight;
                startWaitingSubmissions();
            }
        },
    };
}

export async function estimateImageSubmissionSourceBytes(task: ImageSubmissionSources) {
    const sources = [...task.references, ...(task.mask ? [task.mask] : [])];
    const storageKeys = Array.from(new Set(sources.flatMap((source) => rawReferenceRequestUrlCandidates(source).map(localMediaStorageKeyFromValue).filter(Boolean))));
    const registrations = storageKeys.length ? await getLocalMediaRegistrations(storageKeys, { ownerUserId: task.userId }) : [];
    const registeredBytes = new Map(registrations.map((registration) => [registration.storageKey, registration.bytes]));

    return sources.reduce((total, source) => total + estimateReferenceSourceBytes(source, registeredBytes), 0);
}

export async function runNativeSub2ApiImageSubmission<T>(task: ImageSubmissionSources, operation: () => Promise<T>) {
    const sourceBytes = await estimateImageSubmissionSourceBytes(task);
    // The source buffer, File/ArrayBuffer, Base64 text and serialized request coexist during fetch.
    return nativeSub2ApiSubmissionQueue.run(sourceBytes * NATIVE_SUB2API_MEMORY_MULTIPLIER, operation);
}

function estimateReferenceSourceBytes(reference: ImageTaskReference, registeredBytes: Map<string, number>) {
    const candidates = rawReferenceRequestUrlCandidates(reference);
    const inline = candidates.find((value) => /^data:image\//i.test(value));
    if (inline) return base64DataUrlBytes(inline) || MAX_INLINE_IMAGE_BYTES;
    for (const candidate of candidates) {
        const storageKey = localMediaStorageKeyFromValue(candidate);
        if (storageKey && registeredBytes.has(storageKey)) return Math.max(0, Number(registeredBytes.get(storageKey)) || 0);
    }
    return candidates.length ? MAX_INLINE_IMAGE_BYTES : 0;
}

function base64DataUrlBytes(value: string) {
    const match = value.match(/^data:[^;,]+;base64,([\s\S]+)$/i);
    if (!match) return 0;
    const encoded = match[1].replace(/\s/g, "");
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}
