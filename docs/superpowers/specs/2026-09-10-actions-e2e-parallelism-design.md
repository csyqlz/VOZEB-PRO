# Actions E2E Parallelism Design

## Goal

Reduce Quality and release latency without removing desktop, 390px mobile, 430px mobile, unit, integration, build, lint, type, format, audit, or security coverage.

## Design

Run four isolated GitHub-hosted jobs in parallel: non-browser checks, Chromium desktop E2E, mobile-390 E2E, and mobile-430 E2E. Each browser job keeps one Playwright worker and receives its own PostgreSQL service and application process, preserving the current isolation assumptions while parallelizing at the virtual-machine boundary.

Add an aggregate job with the existing `web` or `quality` identity. The aggregate fails unless every matrix entry succeeds, so existing merge and image-build gates remain explicit. Browser artifacts include the project name to avoid collisions.

The standalone Quality workflow runs for pull requests, `main` pushes, and manual dispatches, but not release tags. Tag publication already invokes the Docker image workflow's own quality gate, so this removes one redundant full E2E run without weakening the release gate.

## Validation

- Parse both workflow files as YAML.
- Assert the exact four-entry matrix, one-project Playwright invocation, unique artifact names, and aggregate gates.
- List Playwright tests for all projects and each individual project on the server.
- Run the repository's relevant workflow linting and full quality checks on `192.168.11.160`.
