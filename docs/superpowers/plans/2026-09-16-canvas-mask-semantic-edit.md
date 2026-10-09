# Canvas Native Mask Edit Implementation Plan

**Goal:** Place the complete requested plant at the selected location with the original room's visual style, keeping the complete native sub2api result instead of hard-clipping it locally.

**Workspace:** 192.168.11.160, /home/github/VOZEB-PRO. Production: /home/VOZEB-PRO/docker-compose.external-db.yml with latest.

## Investigation and Existing Evidence

- [x] Reproduce incorrect Sunburst result after accounts became available.
- [x] Confirm deployed sub2api revision and trace its real image parser and Responses bridge.
- [x] Confirm production model and operation configs still override edits with /images/generations.
- [x] Retain already verified selection metadata, task recovery, and outside-mask compositor.
- [x] Add native-contract TCP failures; observe 4 expected failures and then 61 passing related tests.
- [x] Correct native endpoint, source objects, separate mask object, and style-preserving prompt.
- [x] Compare mismatched mask, aligned mask, and strict placement prompt against the real API; confirm all native full results preserve style while local Alpha composition hard-clips the plant.
- [x] Keep complete native sub2api results and retain local compositing for legacy providers, including persisted retry/recovery behavior.
- [x] TypeScript check passes.

## Remaining Validation

- [x] Add persisted model/system proxy native mask regression and legacy adapter coverage.
- [x] Verify native Sunburst portrait output, style consistency, complete plant, and source/mask alignment behavior.
- [x] Run required tests, lint, format, release checks, UTF-8 validation, build, and Chromium gates.
- [ ] Correct production saved image operation/model configuration through authenticated admin settings.
- [ ] Verify complete plant, original room/style/lighting, selection alignment, and scene continuity without hard clipping.

## Release

- [ ] Commit and create PR; wait for successful Actions and merge into main.
- [ ] Tag merged main v0.0.22 and verify version/latest image publication.
- [ ] Deploy latest and verify app plus generation-worker health and matching image.
- [ ] Perform real production Canvas acceptance and record remaining gaps.
