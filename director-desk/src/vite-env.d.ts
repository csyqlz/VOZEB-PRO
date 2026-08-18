/// <reference types="vite/client" />

declare const __LOCAL_GUO_ASSETS_AVAILABLE__: boolean;
declare const __LOCAL_MIXAMO_CHARACTER_AVAILABLE__: boolean;
declare const __LOCAL_MIXAMO_ANIMATIONS_AVAILABLE__: boolean;
declare const __APP_VERSION__: string;

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}
