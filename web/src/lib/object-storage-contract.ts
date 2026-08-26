import type { ManagedMediaType } from "@/lib/local-media-storage-contract";

export type ObjectStorageSettings = {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    forcePathStyle: boolean;
    hasAccessKeyId: boolean;
    hasSecretAccessKey: boolean;
    updatedAt?: string;
};

export type ObjectStorageSettingsUpdate = {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    clearAccessKeyId?: boolean;
    clearSecretAccessKey?: boolean;
};

export type ExternalStorageFile = {
    key: string;
    name: string;
    directory: string;
    bytes: number;
    lastModified?: string;
    etag?: string;
    type: ManagedMediaType;
    storageKey?: string;
    scope?: "generation" | "reference";
    originalName?: string;
    ownerUserId?: string;
    ownerAccountId?: string;
    ownerUsername?: string;
    ownerDisplayName?: string;
    source?: string;
    referenceCount: number;
    previewUrl: string;
    downloadUrl: string;
    variant: boolean;
};

export type ExternalStorageFilesPayload = {
    items: ExternalStorageFile[];
    nextCursor?: string;
    bucket: string;
    prefix: string;
};

export type ObjectStorageMigrationResult = {
    migrated: number;
    skipped: number;
    failed: number;
    remaining: number;
    errors: Array<{ storageKey: string; message: string }>;
};

export type ObjectStorageDeleteResult = {
    deleted: number;
    blocked: Array<{ key: string; storageKey: string; referenceCount: number }>;
};

export type ObjectStoragePreviewCleanupResult = {
    scanned: number;
    deleted: number;
    reclaimedBytes: number;
};
