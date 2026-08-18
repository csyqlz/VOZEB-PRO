# Project Structure Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce directory noise and oversized-file coupling without changing editor behavior or public APIs.

**Architecture:** Keep the existing domain-oriented monolith, but apply consistent ownership boundaries inside each domain. Tests move into module-local `__tests__` directories, artifacts move out of the repository root, styles gain explicit layers, and large state/rendering modules are decomposed behind their existing exports.

**Tech Stack:** React 18, TypeScript, Zustand 5, React Three Fiber, Vitest, Vite.

---

### Task 1: Establish structure rules

**Files:**
- Create: `docs/plans/2026-07-21-project-structure-refactor.md`

**Steps:**
1. Document target paths and compatibility constraints.
2. Keep public imports and runtime behavior stable during the refactor.
3. Use module-level verification after each migration group.

### Task 2: Group tests by module

**Files:**
- Move: `src/**/*.test.ts(x)` to the nearest module `__tests__/` directory.
- Modify: relative imports and file URL references in moved tests.

**Steps:**
1. Move tests with `git mv` so file history remains traceable.
2. Adjust relative imports by one directory level.
3. Run Vitest for each migrated module.

### Task 3: Clean repository-root artifacts

**Files:**
- Move: milestone documents to `docs/milestones/`.
- Move: smoke/experiment HTML files to `examples/`.
- Move: generated screenshots to `docs/assets/smoke-results/`.
- Modify: `vite.config.ts` and affected documentation links.

**Steps:**
1. Categorize tracked root artifacts by purpose.
2. Move files while retaining build entry points.
3. Verify Vite resolves all HTML inputs.

### Task 4: Layer styles

**Files:**
- Modify: `src/styles/index.css` as the import-only entry point.
- Create: focused files under `src/styles/` for tokens, home, editor shell, motion workspace, and responsive overrides.
- Keep: component-specific motion styles beside the component.

**Steps:**
1. Split existing rules at stable section boundaries without changing order.
2. Import layers in the original cascade order.
3. Run style contract tests and build.

### Task 5: Decompose architectural hotspots

**Files:**
- Modify: `src/editor/store/directorStore.ts`.
- Create: store type, persistence, and slice helper modules under `src/editor/store/`.
- Modify: `DirectorCanvas.tsx`, `SceneRoot.tsx`, and oversized panel/tool components.
- Create: focused helpers/components under their owning module.

**Steps:**
1. Extract pure types and helpers before moving stateful behavior.
2. Preserve `useDirectorStore` and existing component exports.
3. Test each hotspot after extraction.

### Task 6: Verify the refactor

**Files:**
- Modify only files required by failures attributable to the move.

**Steps:**
1. Run all Vitest suites with an extended timeout.
2. Run `npm run build`.
3. Inspect the final tree and Git diff for accidental generated-file churn.
