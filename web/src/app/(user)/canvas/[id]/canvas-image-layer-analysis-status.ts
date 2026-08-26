type CanvasLayerAnalysisMessage = {
    loading: (options: { key: string; content: string; duration: number }) => unknown;
    destroy: (key: string) => void;
};

export async function withCanvasLayerAnalysisStatus<T>(message: CanvasLayerAnalysisMessage, messageKey: string, analyze: () => Promise<T>): Promise<T> {
    message.loading({ key: messageKey, content: "正在分层分析", duration: 0 });
    try {
        return await analyze();
    } finally {
        message.destroy(messageKey);
    }
}
