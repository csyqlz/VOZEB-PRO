import { unzipSync, Zip, ZipPassThrough } from "fflate";

export type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: Iterable<ZipFile> | AsyncIterable<ZipFile>, signal?: AbortSignal) {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
        if (error) throw error;
        if (chunk) chunks.push(chunk);
    });

    try {
        for await (const file of files) {
            if (signal?.aborted) throw new DOMException("ZIP 下载已取消", "AbortError");
            const entry = new ZipPassThrough(file.name);
            zip.add(entry);
            entry.push(new Uint8Array(await new Blob([file.data]).arrayBuffer()), true);
        }
        zip.end();
        return new Blob(chunks as unknown as BlobPart[], { type: "application/zip" });
    } finally {
        zip.terminate();
    }
}

export async function readZip(file: Blob) {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}
