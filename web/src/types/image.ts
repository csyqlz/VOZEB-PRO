import type { ImageEditRegion } from "@/lib/image-edit-region";
import type { VideoReferenceRole } from "@/lib/video-reference-contract";

export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    previewUrl?: string;
    uploadStatus?: "uploading" | "failed";
    uploadError?: string;
    url?: string;
    remoteUrl?: string;
    serverUrl?: string;
    storageKey?: string;
    width?: number;
    height?: number;
    videoRole?: VideoReferenceRole;
    editRegion?: ImageEditRegion;
};
