# Actions Gate Optimization Design

## Goal

Reduce pull request and release latency while retaining desktop browser, static, unit, PostgreSQL integration, build, and security coverage. Mobile Playwright projects remain available for local testing but are removed from GitHub Actions gates.

## Design

Split the current `checks` matrix entry into two independent jobs. `checks` runs dependency audit, ESLint, TypeScript, and Prettier without starting PostgreSQL; `unit` runs Vitest independently. This keeps the established `web / checks` identity while allowing the longest code checks to overlap.

Replace the single Chromium job with two Playwright shards. Each shard receives its own PostgreSQL service, production build, fixture servers, and single Playwright worker. The first shard also runs the serial PostgreSQL integration suite. An aggregate `web` or `quality` job continues to fail unless every required job succeeds.

The Docker image workflow remains tag-driven for production releases. The optimization PR prepares version `v0.0.14`; merging the PR does not publish an image. Tagging the merged `main` commit as `v0.0.14` triggers the signed image and GitHub Release workflow, after which production deployment selects that exact tag.

## Validation

- Parse all changed workflow files as YAML and assert their job graph, names, shard commands, and aggregate results.
- List both Chromium shards and confirm they collectively cover the full Chromium project.
- Run dependency audit, lint, type checking, unit tests, format checking, and production build.
- Push the branch, review the PR diff, and require all PR checks to pass before merge and tagging.
