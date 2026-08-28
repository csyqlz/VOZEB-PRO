import styles from "./theme.module.css";
import { defineVozebThemeBundle } from "../theme-contract";
import { vozebThemeManifest } from "./manifest";

export const vozebThemeBundle = defineVozebThemeBundle({
    manifest: vozebThemeManifest,
    runtimeClassName: styles.root,
});
