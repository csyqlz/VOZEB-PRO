import { readFileSync } from "node:fs";

function readStyleBundle(path = "src/styles/index.css", visited = new Set<string>()): string {
  if (visited.has(path)) return "";
  visited.add(path);

  const source = readFileSync(path, "utf8");
  const basePath = path.slice(0, path.lastIndexOf("/") + 1);
  return source.replace(/@import\s+["']\.\/([^"']+)["'];/g, (_match, importPath: string) =>
    readStyleBundle(`${basePath}${importPath}`, visited)
  );
}

it("uses the StoryAI theme tokens instead of the temporary demo palette", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light;[\s\S]*?--panel-rgb:\s*255 255 255;[\s\S]*?--field-rgb:\s*248 250 252;[\s\S]*?--border-rgb:\s*224 224 224;[\s\S]*?--text-rgb:\s*0 0 0;/);
  expect(css).toMatch(/:root\[data-theme="dark"\],\s*[\r\n]+\s*:root\.dark\s*\{[\s\S]*?color-scheme:\s*dark;[\s\S]*?--panel-rgb:\s*26 26 26;[\s\S]*?--field-rgb:\s*10 10 12;[\s\S]*?--border-rgb:\s*42 42 42;[\s\S]*?--text-rgb:\s*255 255 255;/);
  expect(css).toContain("--accent-rgb: 3 150 255;");
  expect(css).toContain(".ui-panel");
  expect(css).toContain(".ui-field");
  expect(css).toContain(".ui-segmented-item-active");
  expect(css).toMatch(/input:focus-visible,\s*[\r\n]+\s*select:focus-visible,\s*[\r\n]+\s*textarea:focus-visible\s*\{[\s\S]*?outline:\s*1px solid rgb\(var\(--accent-rgb\) \/ 0\.78\);/);
  expect(css).toMatch(/\.ui-field:focus,\s*[\r\n]+\s*\.ui-field:focus-visible,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*input:not\(\[type="range"\]\):not\(\[type="checkbox"\]\):not\(\[type="color"\]\):focus,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*input:not\(\[type="range"\]\):not\(\[type="checkbox"\]\):not\(\[type="color"\]\):focus-visible,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*select:focus,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*select:focus-visible,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*textarea:focus,\s*[\r\n]+\s*\.panel-card:not\(\.right-inspector\)\s*textarea:focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--accent-rgb\) \/ 0\.45\);/);
});

it("paints a dark first frame before React and theme messages initialize", () => {
  const css = readStyleBundle();
  const html = readFileSync("index.html", "utf8");

  expect(html).toMatch(/<style>[\s\S]*?html,\s*body,\s*#root\s*\{[\s\S]*?background:\s*#090909;[\s\S]*?<\/style>/);
  expect(css).toMatch(/html,\s*[\r\n]+\s*body,\s*[\r\n]+\s*#root\s*\{[\s\S]*?background:\s*#090909;/);
});

it("pins the central viewport into a full-bleed director workspace", () => {
  const css = readStyleBundle();

  expect(css).toContain("grid-template-rows: auto 1fr;");
  expect(css).toContain(".director-shell");
  expect(css).toContain(".director-shell-fullbleed");
  expect(css).toContain("--left-sidebar-width: 196px;");
  expect(css).toContain("--right-sidebar-width: 276px;");
  expect(css).toContain("--left-sidebar-content-width: 180px;");
  expect(css).toContain("--right-sidebar-content-width: 260px;");
  expect(css).toMatch(/\.director-shell-fullbleed\s*\{[\s\S]*?position:\s*relative;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  expect(css).toContain("min-height: 70px;");
  expect(css).toContain("padding: 0;");
  expect(css).toContain("gap: 0;");
  expect(css).toContain(".director-shell-fullbleed.is-sidebars-collapsed");
  expect(css).toMatch(/\.left-sidebar,\s*[\r\n]+\s*\.right-sidebar,\s*[\r\n]+\s*\.director-sidebar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?z-index:\s*25;/);
  expect(css).toMatch(/\.left-sidebar\s*\{[\s\S]*?left:\s*0;[\s\S]*?width:\s*var\(--left-sidebar-width\);/);
  expect(css).toMatch(/\.right-sidebar\s*\{[\s\S]*?right:\s*0;[\s\S]*?width:\s*var\(--right-sidebar-width\);/);
  expect(css).toContain(".canvas-frame");
  expect(css).toContain("position: relative;");
  expect(css).toContain(".director-canvas");
  expect(css).toContain("height: 100%;");
  expect(css).toContain(".viewport-toolbar");
  expect(css).toContain("position: absolute;");
  expect(css).toContain("width: max-content;");
  expect(css).toContain("padding: 4px;");
  expect(css).toContain("border-radius: 999px;");
  expect(css).not.toContain("min-height: calc(100vh - 164px);");
});

it("matches the provided top bar and view switch dimensions", () => {
  const css = readStyleBundle();

  expect(css).toContain("grid-template-columns: var(--left-sidebar-width) minmax(0, 1fr) var(--right-sidebar-width);");
  expect(css).toContain("min-height: 70px;");
  expect(css).toMatch(/\.top-bar-title\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?line-height:\s*22px;/);
  expect(css).toMatch(/\.mode-toggle\s*\{[\s\S]*?width:\s*212px;[\s\S]*?height:\s*44px;[\s\S]*?border-radius:\s*12px;/);
  expect(css).toMatch(/\.mode-toggle-button\s*\{[\s\S]*?width:\s*100px;[\s\S]*?height:\s*36px;[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*20px;/);
  expect(css).toMatch(/\.mode-toggle-button\[aria-pressed="true"\]\s*\{[\s\S]*?border-color:\s*rgb\(var\(--accent-rgb\) \/ 0\.28\);[\s\S]*?color:\s*rgb\(var\(--accent-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--accent-rgb\) \/ 0\.12\);/);
  expect(css).not.toContain("border-color: #334B71;");
  expect(css).not.toContain("color: #397AE4;");
  expect(css).not.toContain("background: #1E2735;");
});

it("matches the provided right inspector layout dimensions and field styling", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.right-sidebar\s*\{[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\);[\s\S]*?border-left:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.24\);/);
  expect(css).toMatch(/\.right-sidebar\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\);/);
  expect(css).toMatch(/\.right-inspector\s*\{[\s\S]*?padding:\s*20px 8px;[\s\S]*?gap:\s*0;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*\{[\s\S]*?gap:\s*0;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\);/);
  expect(css).toMatch(/\.right-inspector-title\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?line-height:\s*22px;/);
  expect(css).toMatch(/\.right-inspector-tabs\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-auto-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?grid-auto-flow:\s*column;[\s\S]*?gap:\s*0;[\s\S]*?height:\s*40px;[\s\S]*?margin:\s*10px -8px 0;[\s\S]*?border-bottom:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.24\);/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector-tabs\s*button\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*24px;[\s\S]*?height:\s*40px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;[\s\S]*?white-space:\s*nowrap;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector-tabs\s*button\[aria-pressed="true"\]::after\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*3px;[\s\S]*?border-radius:\s*0;/);
  expect(css).toMatch(/\.right-inspector-content\s*\{[\s\S]*?gap:\s*20px;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?padding-bottom:\s*20px;[\s\S]*?margin-top:\s*25px;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*label\.inspector-field\s*\{[\s\S]*?gap:\s*10px;/);
  expect(css).toMatch(/\.right-inspector-content\s*>\s*\.inspector-field:first-child\s*\{[\s\S]*?margin-bottom:\s*5px;/);
  expect(css).toMatch(/\.inspector-field-label\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;[\s\S]*?color:\s*rgb\(var\(--text-dim-rgb\)\);/);
  expect(css).toMatch(/\.inspector-text-input\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?height:\s*40px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;[\s\S]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.inspector-text-input:focus,\s*[\r\n]+\s*\.inspector-text-input:focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--accent-rgb\) \/ 0\.45\);/);
  expect(css).toMatch(/\.inspector-dropdown\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.inspector-dropdown-trigger\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) 14px;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?min-height:\s*36px;[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.35\);[\s\S]*?border-radius:\s*8px;[\s\S]*?padding:\s*8px 12px;[\s\S]*?background:\s*rgb\(var\(--surface-rgb\)\);[\s\S]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.inspector-dropdown-chevron\s*\{[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;[\s\S]*?color:\s*rgb\(var\(--text-dim-rgb\)\);/);
  expect(css).toMatch(/\.inspector-dropdown-menu\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*calc\(100% \+ 8px\);[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?max-height:\s*288px;[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.4\);[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.78\);[\s\S]*?backdrop-filter:\s*blur\(32px\);/);
  expect(css).toMatch(/\.inspector-dropdown-option\s*\{[\s\S]*?width:\s*calc\(100% - 8px\);[\s\S]*?min-height:\s*34px;[\s\S]*?margin:\s*0 4px;[\s\S]*?border-radius:\s*8px;[\s\S]*?padding:\s*7px 12px;[\s\S]*?font-size:\s*12px;[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.inspector-dropdown-option\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*8px;[\s\S]*?transform:\s*none;/);
  expect(css).toMatch(/\.inspector-dropdown-option:hover,\s*[\r\n]+\s*\.inspector-dropdown-option:focus-visible\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--text-rgb\) \/ 0\.05\);/);
  expect(css).toMatch(/\.inspector-dropdown-option\.is-selected\s*\{[\s\S]*?color:\s*rgb\(var\(--accent-rgb\)\);[\s\S]*?background:\s*transparent;/);
  expect(css).toMatch(/\.inspector-axis-group\s*\{[\s\S]*?gap:\s*10px;/);
  expect(css).toMatch(/\.inspector-axis-input\s*\{[\s\S]*?grid-template-columns:\s*23px minmax\(0,\s*1fr\);[\s\S]*?width:\s*80px;[\s\S]*?height:\s*34px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.inspector-axis-input:focus-within\s*\{[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--accent-rgb\) \/ 0\.45\);/);
  expect(css).toMatch(/\.inspector-axis-input:hover,\s*[\r\n]+\s*\.inspector-axis-input\.is-dragging\s*\{[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--border-rgb\) \/ 0\.55\);/);
  expect(css).toMatch(/\.inspector-axis-input\.is-dragging\s*\{[\s\S]*?background:\s*rgb\(var\(--surface-hover-rgb\)\);/);
  expect(css).toMatch(/\.inspector-axis-prefix\s*\{[\s\S]*?width:\s*23px;[\s\S]*?height:\s*34px;[\s\S]*?margin:\s*0;[\s\S]*?border:\s*0;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?font-size:\s*12px;[\s\S]*?cursor:\s*ew-resize;[\s\S]*?appearance:\s*none;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.inspector-axis-prefix\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?transform:\s*none;/);
  expect(css).toMatch(/\.inspector-axis-prefix:hover,\s*[\r\n]+\s*\.inspector-axis-prefix:focus-visible\s*\{[\s\S]*?outline:\s*none;/);
  expect(css).toMatch(/\.inspector-axis-value\s*\{[\s\S]*?width:\s*57px;[\s\S]*?height:\s*34px;[\s\S]*?border-radius:\s*0;[\s\S]*?padding:\s*0 8px 0 6px;[\s\S]*?background:\s*transparent;[\s\S]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.inspector-axis-value,\s*[\r\n]+\s*\.inspector-text-input\[type="number"\]\s*\{[^}]*?appearance:\s*textfield;/);
  expect(css).toContain(".inspector-axis-value::-webkit-inner-spin-button");
  expect(css).toContain(".inspector-text-input[type=\"number\"]::-webkit-inner-spin-button");
  expect(css).toMatch(/\.inspector-range-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) 80px;[\s\S]*?gap:\s*10px;/);
  expect(css).toMatch(/\.inspector-range\s*\{[\s\S]*?width:\s*100%;/);
  expect(css).toMatch(/\.inspector-range-value\s*\{[\s\S]*?width:\s*80px;[\s\S]*?height:\s*34px;/);
  expect(css).toMatch(/\.panorama-empty-card\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?height:\s*50px;[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*rgb\(var\(--surface-rgb\)\);[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);/);
  expect(css).toMatch(/\.panorama-thumbnail-card\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?height:\s*100px;[\s\S]*?background:\s*#000000;[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.panorama-thumbnail-card::after\s*\{[\s\S]*?background:\s*linear-gradient\(180deg,\s*rgba\(0,\s*0,\s*0,\s*0\)\s*41%,\s*rgba\(0,\s*0,\s*0,\s*0\.6\)\s*100%\);/);
  expect(css).toMatch(/\.panorama-thumbnail-delete\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*8px;[\s\S]*?right:\s*8px;[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;[\s\S]*?line-height:\s*0;[\s\S]*?background:\s*rgba\(0,\s*0,\s*0,\s*0\.52\);[\s\S]*?opacity:\s*0;[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/);
  expect(css).toMatch(/\.panorama-thumbnail-card:hover\s*\.panorama-thumbnail-delete,\s*[\r\n]+\s*\.panorama-thumbnail-card:focus-within\s*\.panorama-thumbnail-delete\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?visibility:\s*visible;[\s\S]*?pointer-events:\s*auto;/);
  expect(css).toMatch(/\.panorama-thumbnail-delete\s*svg\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;[\s\S]*?transform:\s*translateY\(-0\.5px\);/);
  expect(css).toMatch(/\.panorama-thumbnail-delete:active\s*\{[\s\S]*?transform:\s*none;/);
  expect(css).toMatch(/\.panorama-thumbnail-image\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?height:\s*100px;[\s\S]*?border-radius:\s*8px;[\s\S]*?object-fit:\s*cover;/);
  expect(css).toMatch(/\.panorama-thumbnail-name\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;[\s\S]*?color:\s*rgba\(255,\s*255,\s*255,\s*0\.5\);/);
  expect(css).toMatch(/\.camera-capture-section\s*\{[\s\S]*?margin-top:\s*auto;/);
  expect(css).toMatch(/\.camera-capture-section\s*>\s*h3\s*\{[\s\S]*?height:\s*30px;[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*30px;/);
  expect(css).toMatch(/\.camera-capture-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  expect(css).toMatch(/\.camera-capture-card\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*8px;/);
  expect(css).toMatch(/\.camera-capture-thumb-wrap\s*\{[\s\S]*?position:\s*relative;[\s\S]*?aspect-ratio:\s*1 \/ 1;[\s\S]*?overflow:\s*hidden;[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*#000000;/);
  expect(css).toMatch(/\.camera-capture-thumb\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*cover;/);
  expect(css).toMatch(/\.camera-capture-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?height:\s*30px;[\s\S]*?padding:\s*0;[\s\S]*?border-radius:\s*0 0 8px 8px;[\s\S]*?background:\s*rgb\(0 0 0 \/ 0\.72\);[\s\S]*?backdrop-filter:\s*blur\(18px\);[\s\S]*?opacity:\s*0;/);
  expect(css).toMatch(/\.camera-capture-thumb-wrap:hover\s*\.camera-capture-actions,\s*[\r\n]+\s*\.camera-capture-thumb-wrap:focus-within\s*\.camera-capture-actions,\s*[\r\n]+\s*\.camera-capture-actions\.is-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  expect(css).toMatch(/\.camera-capture-action\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*30px;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-action\s*\{[\s\S]*?color:\s*rgb\(255 255 255 \/ 0\.82\);/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-action:hover,\s*[\r\n]+\s*\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-action:focus-visible\s*\{[\s\S]*?color:\s*rgb\(255 255 255\);/);
  expect(css).toMatch(/\.camera-capture-name\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;[\s\S]*?white-space:\s*nowrap;[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/);
  expect(css).toMatch(/\.camera-capture-viewer\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*100000;[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?background:\s*rgb\(0 0 0 \/ 0\.9\);[\s\S]*?backdrop-filter:\s*blur\(4px\);/);
  expect(css).toMatch(/\.camera-capture-viewer-toolbar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*16px;[\s\S]*?right:\s*16px;[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;[\s\S]*?z-index:\s*10;/);
  expect(css).toMatch(/\.camera-capture-viewer-tool\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;[\s\S]*?border:\s*1px solid rgb\(255 255 255 \/ 0\.1\);[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*rgb\(255 255 255 \/ 0\.1\);/);
  expect(css).toMatch(/\.right-inspector\s*button\.camera-capture-viewer-tool\s*\{[\s\S]*?color:\s*rgb\(255 255 255 \/ 0\.9\);/);
  expect(css).toMatch(/\.right-inspector\s*button\.camera-capture-viewer-tool:hover,\s*[\r\n]+\s*\.right-inspector\s*button\.camera-capture-viewer-tool:focus-visible\s*\{[\s\S]*?color:\s*rgb\(255 255 255\);/);
  expect(css).toMatch(/\.camera-capture-viewer-stage\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
  expect(css).toMatch(/\.camera-capture-viewer-image\s*\{[\s\S]*?max-width:\s*80vw;[\s\S]*?max-height:\s*80vh;[\s\S]*?user-select:\s*none;[\s\S]*?border-radius:\s*8px;[\s\S]*?object-fit:\s*contain;[\s\S]*?transition:\s*transform 0\.2s ease;/);
  expect(css).toMatch(/\.camera-capture-viewer-image\.is-zoomed\s*\{[\s\S]*?cursor:\s*grab;/);
  expect(css).toMatch(/\.camera-capture-viewer-image\.is-dragging\s*\{[\s\S]*?cursor:\s*grabbing;[\s\S]*?transition:\s*none;/);
  expect(css).not.toContain(".panorama-preview-card");
  expect(css).toMatch(/\.inspector-color-row\s*\{[\s\S]*?grid-template-columns:\s*34px 214px;[\s\S]*?gap:\s*12px;/);
  expect(css).toMatch(/\.inspector-color-swatch\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.inspector-color-swatch:focus,\s*[\r\n]+\s*\.inspector-color-swatch:focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--accent-rgb\) \/ 0\.45\);/);
  expect(css).toMatch(/\.inspector-color-hex\s*\{[\s\S]*?width:\s*214px;[\s\S]*?height:\s*34px;/);
  expect(css).toMatch(/\.scene-inspector\s*\.inspector-section\s*h3\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*20px;/);
  expect(css).toMatch(/\.scene-inspector\s*\.inspector-section\s*\{[\s\S]*?margin-top:\s*10px;/);
  expect(css).toMatch(/\.panorama-empty-card\s*\{[\s\S]*?justify-content:\s*center;[\s\S]*?gap:\s*8px;/);
  expect(css).toMatch(/\.panorama-empty-icon\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  expect(css).toMatch(/\.scene-switch-row\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*10px;/);
  expect(css).toMatch(/\.scene-switch-row\s*\.inspector-toggle-row\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.scene-switch-row\s*\.inspector-toggle-row\s*span\s*\{[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);[\s\S]*?white-space:\s*nowrap;/);
  expect(css).toMatch(/\.character-inspector\s*\.right-inspector-content,\s*[\r\n]+\s*\.character-inspector\s*\.right-inspector-content\s*>\s*\.inspector-section\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?max-width:\s*100%;/);
  expect(css).toMatch(/\.character-inspector\s*\{[\s\S]*?width:\s*var\(--right-sidebar-width\);[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow-x:\s*hidden;/);
}
);

it("matches the provided left object panel layout and icon button styling", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.left-sidebar\s*\{[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\);[\s\S]*?border-right:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.24\);/);
  expect(css).toMatch(/\.object-tree-panel\s*\{[\s\S]*?height:\s*100%;[\s\S]*?gap:\s*25px;[\s\S]*?padding:\s*20px 8px;/);
  expect(css).toMatch(/\.object-search-field\s*\.ui-field\s*\{[\s\S]*?width:\s*var\(--left-sidebar-content-width\);[\s\S]*?height:\s*40px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;[\s\S]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.left-sidebar\s*\.object-search-field\s*\.ui-field\s*\{[\s\S]*?width:\s*var\(--left-sidebar-content-width\);[\s\S]*?height:\s*40px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.left-sidebar\s*\.object-search-field\s*input\.ui-field\s*\{[\s\S]*?width:\s*var\(--left-sidebar-content-width\);[\s\S]*?height:\s*40px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.left-sidebar\s*\.object-tree-panel\s*\.object-search-field\s*input\.ui-field:not\(\[type="range"\]\):not\(\[type="checkbox"\]\):not\(\[type="color"\]\)\s*\{[\s\S]*?width:\s*var\(--left-sidebar-content-width\);[\s\S]*?height:\s*40px;[\s\S]*?background:\s*rgb\(var\(--field-rgb\)\);[\s\S]*?border-radius:\s*8px;/);
  expect(css).toMatch(/\.object-tree-groups\s*\{[\s\S]*?gap:\s*20px;/);
  expect(css).toMatch(/\.object-tree-group\s*\{[\s\S]*?gap:\s*4px;/);
  expect(css).toMatch(/\.left-sidebar\s*\.object-tree-panel\s*\.object-search-field\s*input\.ui-field:not\(\[type="range"\]\):not\(\[type="checkbox"\]\):not\(\[type="color"\]\):focus,\s*[\r\n]+\s*\.left-sidebar\s*\.object-tree-panel\s*\.object-search-field\s*input\.ui-field:not\(\[type="range"\]\):not\(\[type="checkbox"\]\):not\(\[type="color"\]\):focus-visible\s*\{[\s\S]*?outline:\s*none;[\s\S]*?box-shadow:\s*0 0 0 1px rgb\(var\(--accent-rgb\) \/ 0\.45\);/);
  expect(css).toMatch(/\.object-search-empty-state\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?min-height:\s*0;[\s\S]*?height:\s*100%;/);
  expect(css).toMatch(/\.object-search-empty-icon\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;[\s\S]*?line-height:\s*0;/);
  expect(css).toMatch(/\.object-search-empty-state\s*>\s*span:last-child\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?min-height:\s*17px;/);
  expect(css).toMatch(/\.object-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) 28px 28px;[\s\S]*?min-height:\s*45px;[\s\S]*?padding:\s*0 8px;/);
  expect(css).toMatch(/\.object-row\[aria-selected="true"\]\s*\{[\s\S]*?background:\s*rgb\(var\(--surface-hover-rgb\)\);/);
  expect(css).toMatch(/\.object-row:hover\s*\{[\s\S]*?background:\s*rgb\(var\(--surface-hover-rgb\) \/ 0\.8\);/);
  expect(css).toMatch(/\.object-select-button\s*\{[\s\S]*?gap:\s*8px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.object-row\s*\.object-select-button:hover,\s*[\r\n]+\s*\.object-row\s*\.object-icon-flag-button:hover\s*\{[\s\S]*?background:\s*transparent;/);
  expect(css).toMatch(/\.object-row-kind-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  expect(css).toMatch(/\.object-icon-flag-button\s*\{[\s\S]*?border:\s*0;[\s\S]*?color:\s*rgb\(var\(--text-dim-rgb\)\);[\s\S]*?box-shadow:\s*none;/);
  expect(css).toMatch(/\.object-row\s*\.object-icon-flag-button\s*\{[\s\S]*?color:\s*rgb\(var\(--text-dim-rgb\)\);[\s\S]*?background:\s*transparent;/);
  expect(css).toMatch(/\.object-row:hover\s*\.object-icon-flag-button\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);/);
});

it("uses the selected image card capsule style for viewport icon actions", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.viewport-toolbar\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*calc\(100% - 32px\);[\s\S]*?gap:\s*4px;[\s\S]*?padding:\s*4px;/);
  expect(css).toMatch(/\.viewport-toolbar-button\.ui-icon-button\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?border:\s*0;[\s\S]*?padding:\s*0;/);
  expect(css).toMatch(/\.viewport-toolbar-button\.ui-icon-button:hover\s*\{[\s\S]*?background:\s*rgb\(var\(--text-rgb\) \/ 0\.08\);/);
  expect(css).toMatch(/\.viewport-toolbar-menu\s*\{[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.35\);[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.9\);[\s\S]*?backdrop-filter:\s*blur\(32px\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(32px\);/);
  expect(css).toMatch(/\.viewport-toolbar-menu button,\s*[\r\n]+\s*\.viewport-toolbar-submenu button\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*30px;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*10px;[\s\S]*?padding:\s*0 9px;[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);[\s\S]*?background:\s*transparent;[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*600;[\s\S]*?line-height:\s*17px;[\s\S]*?text-align:\s*left;/);
  expect(css).toMatch(/\.viewport-toolbar-menu button:hover,\s*[\r\n]+\s*\.viewport-toolbar-menu button:focus-visible,\s*[\r\n]+\s*\.viewport-toolbar-submenu button:hover,\s*[\r\n]+\s*\.viewport-toolbar-submenu button:focus-visible\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--text-rgb\) \/ 0\.08\);/);
  const submenuRule = css.match(/\.viewport-toolbar-submenu\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";
  expect(submenuRule).toContain("bottom: 0;");
  expect(submenuRule).not.toContain("top: 0;");
  expect(submenuRule).toContain("background: rgb(var(--panel-rgb) / 0.9);");
  expect(submenuRule).toContain("backdrop-filter: blur(32px);");
  expect(submenuRule).toContain("-webkit-backdrop-filter: blur(32px);");
  expect(css).toMatch(/\.viewport-toolbar-crowd-panel\s*\{[\s\S]*?width:\s*260px;[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.35\);[\s\S]*?border-radius:\s*22px;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.9\);[\s\S]*?backdrop-filter:\s*blur\(32px\);/);
  expect(css).toMatch(/\.viewport-toolbar-crowd-panel-count\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.viewport-toolbar-crowd-field span\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.viewport-toolbar-crowd-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*12px;/);
  expect(css).toMatch(/\.viewport-toolbar-crowd-actions button\s*\{[\s\S]*?height:\s*38px;[\s\S]*?border-radius:\s*8px;/);
  expect(css).toContain(".viewport-toolbar-crowd-cancel.camera-capture-clear-all");
  expect(css).toContain(".viewport-toolbar-crowd-confirm.camera-capture-send-all");
  expect(css).toMatch(/\.viewport-toolbar-crowd-confirm\.camera-capture-send-all\s*\{[\s\S]*?color:\s*rgb\(255 255 255\);[\s\S]*?background:\s*rgb\(var\(--accent-rgb\)\);/);
  expect(css).toMatch(/\.viewport-toolbar-crowd-confirm\.camera-capture-send-all:hover,\s*[\r\n]+\s*\.viewport-toolbar-crowd-confirm\.camera-capture-send-all:focus-visible\s*\{[\s\S]*?background:\s*rgb\(var\(--accent-rgb\) \/ 0\.88\);/);
  expect(css).toContain(".viewport-toolbar-label");
});

it("renders the model library panel with the same frosted glass background treatment", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.model-library-panel\s*\{[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.35\);[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.9\);[\s\S]*?backdrop-filter:\s*blur\(32px\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(32px\);/);
  expect(css).toMatch(/\.model-library-tab\.is-active::after\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*3px;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*rgb\(var\(--accent-rgb\)\);/);
  expect(css).toMatch(/\.model-library-close-button\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?padding:\s*0;[\s\S]*?line-height:\s*0;/);
  expect(css).toMatch(/\.model-library-close-button\s*svg\s*\{[\s\S]*?display:\s*block;/);
  const modelLibraryThumbHoverRule =
    css.match(
      /\.model-library-card:hover\s*\.model-library-thumb,\s*[\r\n]+\s*\.model-library-card:focus-visible\s*\.model-library-thumb\s*\{(?<body>[\s\S]*?)\}/
    )?.groups?.body ?? "";
  expect(modelLibraryThumbHoverRule).toContain("background: rgb(var(--surface-hover-rgb));");
  expect(modelLibraryThumbHoverRule).not.toContain("border-color:");
  expect(css).toMatch(/\.model-library-thumb-image\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*cover;/);
});

it("renders the viewport aspect ratio picker as a horizontal floating panel", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.viewport-aspect-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(40px \+ var\(--viewport-toolbar-height,\s*46px\) \+ 10px\);[\s\S]*?width:\s*min\(340px,\s*calc\(100% - 16px\)\);[\s\S]*?height:\s*206px;[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.35\);[\s\S]*?border-radius:\s*22px;[\s\S]*?background:\s*rgb\(var\(--panel-rgb\) \/ 0\.9\);[\s\S]*?backdrop-filter:\s*blur\(32px\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(32px\);/);
  expect(css).toMatch(/\.viewport-aspect-panel-title\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.viewport-aspect-panel-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*8px;/);
  expect(css).toMatch(/\.viewport-aspect-option\s*\{[\s\S]*?gap:\s*8px;[\s\S]*?height:\s*70px;[\s\S]*?border-radius:\s*18px;[\s\S]*?background:\s*rgb\(var\(--surface-rgb\) \/ 0\.35\);/);
  expect(css).toMatch(/\.viewport-aspect-option\.is-active\s*\{[\s\S]*?border-color:\s*rgb\(var\(--border-rgb\)\);[\s\S]*?background:\s*rgb\(var\(--surface-hover-rgb\) \/ 0\.8\);[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);/);
  expect(css).toMatch(/\.viewport-aspect-option-frame\s*\{[\s\S]*?border:\s*2px solid currentColor;[\s\S]*?border-radius:\s*6px;/);
});

it("renders the viewport aspect frame overlay with frosted mask treatment", () => {
  const css = readStyleBundle();
  const maskRule = css.match(/\.viewport-aspect-mask\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";
  const shellRule = css.match(/\.viewport-aspect-frame-shell\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";

  expect(css).toMatch(/\.viewport-aspect-overlay\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none;/);
  expect(maskRule).toContain("position: absolute;");
  expect(maskRule).toContain("inset: 0;");
  expect(maskRule).toContain("z-index: 0;");
  expect(maskRule).toContain("backdrop-filter: blur(22px);");
  expect(maskRule).toContain("-webkit-backdrop-filter: blur(22px);");
  expect(maskRule).toContain("-webkit-mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0);");
  expect(maskRule).toContain("-webkit-mask-size: 100% 100%, var(--viewport-aspect-frame-width) var(--viewport-aspect-frame-height);");
  expect(maskRule).toContain("-webkit-mask-position: 0 0, var(--viewport-aspect-frame-left) var(--viewport-aspect-frame-top);");
  expect(maskRule).toContain("-webkit-mask-composite: xor;");
  expect(maskRule).toContain("mask-composite: exclude;");
  expect(shellRule).toContain("position: absolute;");
  expect(shellRule).toContain("z-index: 1;");
  expect(shellRule).toContain("border-radius: 22px;");
  expect(shellRule).toContain("overflow: hidden;");
  expect(shellRule).toContain("inset 0 0 0 1px rgb(255 255 255 / 0.04)");
  expect(shellRule).not.toContain("0 18px 60px");
  expect(css).toMatch(/\.viewport-aspect-guide-toggle\s*\{[\s\S]*?top:\s*12px;[\s\S]*?left:\s*12px;[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?backdrop-filter:\s*blur\(18px\);/);
  expect(css).toMatch(/\.viewport-rule-of-thirds\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none;/);
  expect(css).toMatch(/\.viewport-rule-of-thirds-line\s*\{[\s\S]*?background:\s*rgb\(255 255 255 \/ 0\.3\);/);
  expect(css).toMatch(/\.viewport-rule-of-thirds-line\.is-vertical\s*\{[\s\S]*?width:\s*0\.5px;/);
  expect(css).toMatch(/\.viewport-rule-of-thirds-line\.is-horizontal\s*\{[\s\S]*?height:\s*0\.5px;/);
  expect(css).toMatch(/\.viewport-rule-of-thirds-line\.is-one-third\.is-vertical\s*\{[\s\S]*?left:\s*33\.333333%;/);
  expect(css).toMatch(/\.viewport-rule-of-thirds-line\.is-two-thirds\.is-horizontal\s*\{[\s\S]*?top:\s*66\.666667%;/);
});

it("keeps the native viewport gizmo in a separate overlay above the frosted aspect mask", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.viewport-gizmo-overlay\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*20px;[\s\S]*?right:\s*20px;[\s\S]*?z-index:\s*20;[\s\S]*?width:\s*80px;[\s\S]*?height:\s*80px;[\s\S]*?pointer-events:\s*auto;/);
  expect(css).toMatch(/\.viewport-gizmo-overlay\s*>\s*div,\s*[\r\n]+\s*\.viewport-gizmo-overlay\s*canvas\s*\{[\s\S]*?width:\s*100%\s*!important;[\s\S]*?height:\s*100%\s*!important;/);
  expect(css).toMatch(/\.viewport-gizmo-hit-layer\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none;/);
  expect(css).toMatch(/\.viewport-gizmo-hit-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*15px;[\s\S]*?height:\s*15px;[\s\S]*?background:\s*transparent;[\s\S]*?pointer-events:\s*auto;/);
  expect(css).toMatch(/\.viewport-aspect-overlay\s*\{[\s\S]*?z-index:\s*6;/);
});

it("shows icon names as a floating label on viewport toolbar hover and focus", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.viewport-toolbar-button\s*\.viewport-toolbar-label\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ 10px\);[\s\S]*?border-radius:\s*999px;[\s\S]*?opacity:\s*0;/);
  expect(css).toMatch(/\.viewport-toolbar-button\s*\.viewport-toolbar-label\s*\{[^}]*?font-size:\s*12px;/);
  expect(css).toMatch(/\.viewport-toolbar-button:hover\s*\.viewport-toolbar-label,\s*[\r\n]+\s*\.viewport-toolbar-button:focus-visible\s*\.viewport-toolbar-label\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?visibility:\s*visible;/);
});

it("renders viewport object labels without an outline stroke", () => {
  const css = readStyleBundle();
  const labelRule = css.match(/\.role-label\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";

  expect(labelRule).toContain("border-radius: 999px;");
  expect(labelRule).not.toMatch(/(^|\s)border:/);
});

it("lays out character pose presets as the requested 4 by 5 compact grid", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.pose-preset-section\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?max-width:\s*100%;/);
  expect(css).toMatch(/\.preset-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*57px\);[\s\S]*?column-gap:\s*10\.6667px;[\s\S]*?row-gap:\s*8px;[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?justify-content:\s*start;/);
  expect(css).toMatch(/\.preset-grid\s*button\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*57px;[\s\S]*?height:\s*34px;[\s\S]*?padding:\s*0;[\s\S]*?text-align:\s*center;[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;/);
  expect(css).toMatch(/\.preset-grid\s*button\.is-active\s*\{[\s\S]*?color:\s*rgb\(var\(--accent-rgb\)\);/);
});

it("styles the character pose adjustment section title and content alignment", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.pose-adjust-section\s*\{[\s\S]*?justify-items:\s*start;/);
  expect(css).toMatch(/\.pose-preset-section\s*>\s*\.pose-adjust-section\s*\{[\s\S]*?margin-top:\s*18px;/);
  expect(css).toMatch(/\.pose-adjust-section\s*>\s*h3\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*20px;/);
  expect(css).toMatch(/\.pose-adjust-section\s*\.pose-groups\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?justify-items:\s*start;/);
  expect(css).toMatch(/\.pose-adjust-section\s*\.pose-group\s*\{[\s\S]*?justify-items:\s*start;[\s\S]*?padding:\s*0;/);
});

it("styles the camera screenshot overview as grouped content with footer actions and centered empty state", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.camera-capture-overview\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);[\s\S]*?gap:\s*0;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\.camera-inspector-captures\s*\{[\s\S]*?height:\s*100%;[\s\S]*?overflow:\s*hidden;/);
  expect(css).toMatch(/\.camera-capture-tab\s*\{[\s\S]*?height:\s*100%;/);
  expect(css).toMatch(/\.camera-capture-overview-scroll\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?padding:\s*30px 0 20px 20px;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-x:\s*hidden;/);
  expect(css).toMatch(/\.camera-capture-group\s*>\s*h3\s*\{[\s\S]*?color:\s*rgb\(var\(--text-rgb\)\);[\s\S]*?font-size:\s*14px;/);
  expect(css).toMatch(/\.camera-capture-empty\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);[\s\S]*?max-width:\s*100%;/);
  expect(css).toMatch(/\.camera-inspector-captures\s*\.right-inspector-content\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?top:\s*92px;[\s\S]*?bottom:\s*78px;[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\);[\s\S]*?width:\s*auto;[\s\S]*?margin-top:\s*0;[\s\S]*?padding:\s*0;[\s\S]*?overflow:\s*hidden;/);
  expect(css).toMatch(/\.camera-capture-overview-footer\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?grid-template-columns:\s*125px 125px;[\s\S]*?gap:\s*10px;[\s\S]*?width:\s*var\(--right-sidebar-width\);[\s\S]*?height:\s*78px;[\s\S]*?padding:\s*20px;[\s\S]*?border-top:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.24\);[\s\S]*?background:\s*rgb\(var\(--panel-rgb\)\);/);
  expect(css).toMatch(/\.camera-capture-current-button,\s*[\r\n]+\.camera-capture-clear-all,\s*[\r\n]+\.camera-capture-send-all\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?height:\s*38px;[\s\S]*?border-radius:\s*8px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*17px;[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);/);
  expect(css).toMatch(/\.camera-capture-current-button\s*\{[\s\S]*?width:\s*var\(--right-sidebar-content-width\);/);
  expect(css).toMatch(/\.camera-capture-clear-all,\s*[\r\n]+\.camera-capture-send-all\s*\{[\s\S]*?width:\s*125px;/);
  expect(css).toMatch(/\.camera-capture-current-button\s*svg,\s*[\r\n]+\.camera-capture-clear-all\s*svg,\s*[\r\n]+\.camera-capture-send-all\s*svg\s*\{[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;/);
  expect(css).toMatch(/\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-current-button,\s*[\r\n]+\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-clear-all,\s*[\r\n]+\.right-sidebar\s*\.right-inspector\s*button\.camera-capture-send-all\s*\{[\s\S]*?border:\s*1px solid rgb\(var\(--border-rgb\) \/ 0\.24\);[\s\S]*?color:\s*rgb\(var\(--text-muted-rgb\)\);[\s\S]*?background:\s*transparent;/);
  expect(css).not.toContain(".camera-capture-send-all.is-hover-state");
});

it("does not install a full-viewport transform drag layer over the handle-based controls", () => {
  const css = readStyleBundle();

  expect(css).not.toContain(".viewport-transform-drag-layer");
  expect(css).toMatch(/\.viewport-toolbar\s*\{[\s\S]*?z-index:\s*10;/);
});

it("keeps the viewport toolbar 40px below the framed viewport area", () => {
  const css = readStyleBundle();

  expect(css).toMatch(/\.viewport-toolbar\s*\{[\s\S]*?bottom:\s*40px;/);
  expect(css).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.app-shell \.viewport-toolbar\s*\{[\s\S]*?width:\s*calc\(100% - 16px\);[\s\S]*?height:\s*auto;[\s\S]*?flex-wrap:\s*wrap;/);
});

it("keeps the demo usable in narrower in-app browser widths", () => {
  const css = readStyleBundle();

  expect(css).toContain("@media (max-width: 1180px)");
  expect(css).toMatch(/@media \(max-width: 1180px\)\s*\{[\s\S]*?\.director-shell-fullbleed\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  expect(css).not.toContain("min-width: 1280px;");
});
