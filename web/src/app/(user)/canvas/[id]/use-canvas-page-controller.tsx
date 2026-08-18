"use client";

import { useCanvasGenerationActions } from "./use-canvas-generation-actions";
import { useCanvasInteractions } from "./use-canvas-interactions";
import { useCanvasMediaActions } from "./use-canvas-media-actions";
import { useCanvasPageState } from "./use-canvas-page-state";
import { useCanvasPersistenceEffects } from "./use-canvas-persistence-effects";
import { useCanvasTaskRuntime } from "./use-canvas-task-runtime";
import { useCanvasDirectorActions } from "./use-canvas-director-actions";

export function useCanvasPageController() {
    const state = useCanvasPageState();
    const tasks = useCanvasTaskRuntime({ state });
    useCanvasPersistenceEffects({ state, tasks });
    const interactions = useCanvasInteractions({ state });
    const media = useCanvasMediaActions({ state, tasks, interactions });
    const generation = useCanvasGenerationActions({ state, tasks, interactions });
    const director = useCanvasDirectorActions({ state });
    return { ...state, ...tasks, ...interactions, ...media, ...generation, ...director };
}

export type CanvasPageController = ReturnType<typeof useCanvasPageController>;
