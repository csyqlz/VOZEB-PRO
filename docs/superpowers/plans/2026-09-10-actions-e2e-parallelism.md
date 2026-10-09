# Actions E2E Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallelize the existing Actions quality coverage while keeping the release and branch gates intact.

**Architecture:** Both workflows use an isolated four-entry matrix and a stable aggregate gate. Playwright remains single-worker inside each database-isolated job.

**Tech Stack:** GitHub Actions, pnpm 11.9.0, Node.js 22, Playwright, PostgreSQL 16.6.

## Global Constraints

- Run all Node.js validation on `192.168.11.160`.
- Do not remove desktop or mobile E2E coverage.
- Do not make E2E tests share a PostgreSQL instance across parallel jobs.
- Preserve the Docker build dependency on a successful quality gate.

---

### Task 1: Parallelize standalone Quality

**Files:**
- Modify: `.github/workflows/quality.yml`
- Test: `verify-first-version.mjs` temporary structural harness

- [ ] Run the structural harness and confirm it fails because `web-suite` is absent.
- [ ] Replace the sequential `web` job with the four-entry `web-suite` matrix.
- [ ] Add an aggregate `web` job that fails unless the matrix succeeds.
- [ ] Remove the tag trigger while retaining `main`, pull request, and manual triggers.
- [ ] Run the structural harness and YAML validation.

### Task 2: Parallelize release quality

**Files:**
- Modify: `.github/workflows/docker-image.yml`
- Test: `verify-first-version.mjs` temporary structural harness

- [ ] Replace the sequential `quality` job with the four-entry `quality-suite` matrix.
- [ ] Add an aggregate `quality` job so `build` retains its existing dependency.
- [ ] Keep security, metadata, build, manifest, attestation, and release jobs unchanged.
- [ ] Run the structural harness and YAML validation.

### Task 3: Verify and publish

**Files:**
- Verify: `.github/workflows/quality.yml`
- Verify: `.github/workflows/docker-image.yml`

- [ ] Confirm Playwright lists 78 Chromium, 41 mobile-390, 41 mobile-430, and 3 setup tests.
- [ ] Run relevant Node, workflow, encoding, and Git diff checks on the server.
- [ ] Commit the implementation and push the feature branch for Actions validation.
