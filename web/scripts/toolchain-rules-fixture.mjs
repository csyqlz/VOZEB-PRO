import { test } from "node:test";

import { checkInstalledProjectRules } from "./toolchain-rules-check.mjs";

test("complete installed project rule names and severities retain the baseline", checkInstalledProjectRules);
