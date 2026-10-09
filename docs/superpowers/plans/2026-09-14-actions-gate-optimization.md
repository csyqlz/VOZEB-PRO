# Actions Gate Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten VOZEB PRO pull request and release gates while preserving required desktop and code coverage.

**Architecture:** Static checks, unit tests, and two isolated Chromium shards run in parallel. Stable aggregate jobs retain the existing required gate identities, and versioned production publication remains tied to an exact Git tag.

**Tech Stack:** GitHub Actions, pnpm 11.9.0, Node.js 22, Vitest, Playwright, PostgreSQL 16.6, Docker Buildx.

## Global Constraints

- Remove `mobile-390` and `mobile-430` only from Actions; keep their Playwright project definitions.
- Keep one Playwright worker and an isolated PostgreSQL service per Chromium shard.
- Preserve aggregate `web` and `quality` gate names.
- Publish production artifacts only after tagging the merged `main` commit as `v0.0.14`.

---

### Task 1: Split the standalone Quality gate

**Files:**
- Modify: `.github/workflows/quality.yml`

- [x] Replace `web-suite` with `web-checks`, `web-unit`, and a two-entry `web-chromium` shard matrix.
- [x] Run PostgreSQL integration tests only in Chromium shard 1.
- [x] Make aggregate `web` verify all three job results.

### Task 2: Split the release Quality gate

**Files:**
- Modify: `.github/workflows/docker-image.yml`

- [x] Mirror the static, unit, and Chromium shard jobs under `quality-*` names.
- [x] Make aggregate `quality` verify all three job results while retaining the existing Docker build dependency.
- [x] Keep image publication and release creation tied to version tags.

### Task 3: Prepare and verify version `v0.0.14`

**Files:**
- Modify: `VERSION`
- Modify: `CHANGELOG.md`
- Verify: `.github/workflows/quality.yml`
- Verify: `.github/workflows/docker-image.yml`

- [x] Set `VERSION` to `v0.0.14` and move current release notes under `v0.0.14`.
- [x] Parse YAML and assert job names, conditions, shard arguments, and aggregate dependencies.
- [x] List both Playwright shards and run the repository quality commands.
- [ ] Commit, push, open the PR, and wait for all required checks before merge and tagging.
