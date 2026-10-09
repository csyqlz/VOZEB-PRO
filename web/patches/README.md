# Next ESLint directory scanner

`@next/eslint-plugin-next@16.3.8` only uses `fast-glob.globSync()` to locate Next root directories. The scoped pnpm alias replaces that dependency with the existing `tinyglobby@0.2.17`, removing the vulnerable `micromatch → braces` chain.

The patch disables tinyglobby's automatic directory expansion and preserves absolute versus relative paths. Next joins the returned paths with `pages`, `src/pages`, `app` and `src/app`, so a trailing directory slash has no effect. `scripts/next-eslint-root-dirs.test.mjs` exercises real directories, Windows separators, glob patterns and internal-link linting.

Keep the override and patch scoped to this plugin version. Reassess both when upgrading Next, and copy `patches/` before the frozen install in Docker. Do not reintroduce the shadcn CLI as a stylesheet dependency; the Radix Select variants used by the app are in `src/app/styles/global-selection-controls.css`.
