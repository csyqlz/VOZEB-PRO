import { useEffect, useState } from "react";
import { getStoredAssetKey, localAssetBinaryStorage } from "./localAssetBinaryStorage";

export function useResolvedLocalAssetUrl(asset: { url: string; storageKey?: string } | undefined) {
  const storageKey = asset?.storageKey ?? (asset ? getStoredAssetKey(asset.url) : null);
  const directUrl = asset && !storageKey ? asset.url : undefined;
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(directUrl);

  useEffect(() => {
    setResolvedUrl(directUrl);
    if (!storageKey) return;

    let disposed = false;
    let objectUrl: string | null = null;
    void localAssetBinaryStorage.read(storageKey)
      .then((record) => {
        if (!record || disposed) return;
        objectUrl = URL.createObjectURL(record.blob);
        setResolvedUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setResolvedUrl(undefined);
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directUrl, storageKey]);

  return resolvedUrl;
}
