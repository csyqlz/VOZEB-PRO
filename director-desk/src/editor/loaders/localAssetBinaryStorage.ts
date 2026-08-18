export interface LocalAssetBinaryRecord {
  key: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  byteLength: number;
  updatedAt: number;
}

export interface LocalAssetBinaryBackend {
  put: (record: LocalAssetBinaryRecord) => Promise<void>;
  get: (key: string) => Promise<LocalAssetBinaryRecord | null>;
  delete: (key: string) => Promise<void>;
}

const DATABASE_NAME = "storyai-3d-director-assets";
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "binary-assets";
const STORED_ASSET_URL_PREFIX = "director-asset://local/";

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("本地模型存储失败")));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("本地模型存储已中止")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("本地模型存储失败")));
  });
}

function openDatabase(factory: IDBFactory) {
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
      database.createObjectStore(OBJECT_STORE_NAME, { keyPath: "key" });
    }
  });
  return requestResult(request);
}

export function createIndexedDbLocalAssetBackend(factory: IDBFactory): LocalAssetBinaryBackend {
  return {
    async put(record) {
      const database = await openDatabase(factory);
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      transaction.objectStore(OBJECT_STORE_NAME).put(record);
      await transactionDone(transaction);
      database.close();
    },
    async get(key) {
      const database = await openDatabase(factory);
      const transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
      const record = await requestResult(
        transaction.objectStore(OBJECT_STORE_NAME).get(key) as IDBRequest<LocalAssetBinaryRecord | undefined>
      );
      await transactionDone(transaction);
      database.close();
      return record ?? null;
    },
    async delete(key) {
      const database = await openDatabase(factory);
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      transaction.objectStore(OBJECT_STORE_NAME).delete(key);
      await transactionDone(transaction);
      database.close();
    },
  };
}

function getDefaultBackend() {
  return typeof indexedDB === "undefined" ? null : createIndexedDbLocalAssetBackend(indexedDB);
}

export function createLocalAssetBinaryStorage(backend: LocalAssetBinaryBackend | null) {
  return {
    isAvailable: Boolean(backend),
    async save(file: File, key: string = crypto.randomUUID()) {
      if (!backend) throw new Error("当前浏览器不支持大型本地模型存储");
      const record: LocalAssetBinaryRecord = {
        key,
        blob: file,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        byteLength: file.size,
        updatedAt: Date.now(),
      };
      await backend.put(record);
      return record;
    },
    async read(key: string) {
      if (!backend) return null;
      return backend.get(key);
    },
    async remove(key: string) {
      if (!backend) return;
      await backend.delete(key);
    },
  };
}

export const localAssetBinaryStorage = createLocalAssetBinaryStorage(getDefaultBackend());

export function createStoredAssetUrl(storageKey: string) {
  return `${STORED_ASSET_URL_PREFIX}${encodeURIComponent(storageKey)}`;
}

export function getStoredAssetKey(url: string) {
  return url.startsWith(STORED_ASSET_URL_PREFIX)
    ? decodeURIComponent(url.slice(STORED_ASSET_URL_PREFIX.length))
    : null;
}
