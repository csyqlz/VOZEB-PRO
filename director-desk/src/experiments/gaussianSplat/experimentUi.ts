function metric(label: string, value: string, id: string) {
  return `<span class="experiment-metric"><small>${label}</small><strong id="${id}">${value}</strong></span>`;
}

export interface ExperimentUi {
  viewport: HTMLElement;
  fileInput: HTMLInputElement;
  importButton: HTMLButtonElement;
  resetSceneButton: HTMLButtonElement;
  scaleSelect: HTMLSelectElement;
  formatSelect: HTMLSelectElement;
  generateButton: HTMLButtonElement;
  resetViewButton: HTMLButtonElement;
  rotateButton: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  moveCharacterButton: HTMLButtonElement;
  addProxyButton: HTMLButtonElement;
  clearProxyButton: HTMLButtonElement;
  collisionToggle: HTMLInputElement;
  proxyToggle: HTMLInputElement;
  benchmarkButton: HTMLButtonElement;
  reportButton: HTMLButtonElement;
  sourceStatus: HTMLElement;
  pickStatus: HTMLElement;
  collisionStatus: HTMLElement;
  benchmarkStatus: HTMLElement;
  countOutput: HTMLElement;
  bytesOutput: HTMLElement;
  loadOutput: HTMLElement;
  fpsOutput: HTMLElement;
  memoryOutput: HTMLElement;
}

function requireChild<T extends Element>(root: ParentNode, selector: string) {
  const child = root.querySelector<T>(selector);
  if (!child) throw new Error(`实验界面缺少 ${selector}`);
  return child;
}

export function mountExperimentUi(root: HTMLElement): ExperimentUi {
  root.innerHTML = `
    <section class="experiment-shell" aria-label="高斯泼溅浏览器承载实验">
      <div class="experiment-toolbar" role="toolbar" aria-label="高斯泼溅实验工具">
        <button type="button" id="back-to-director">返回导演台</button>
        <span class="experiment-brand"><strong>高斯泼溅实验</strong><small>真实场景显示 + 代理碰撞验证</small></span>
        <span class="experiment-badge">独立实验</span>
        <button type="button" id="reset-view">重置视角</button>
        <button type="button" id="toggle-rotation" aria-pressed="false">环绕观察</button>
        <button type="button" id="export-frame">导出画面</button>
      </div>

      <aside class="experiment-panel" aria-label="高斯实验控制台">
        <section>
          <header><strong>高斯场景</strong><small>支持 PLY / SPLAT / KSPLAT</small></header>
          <div class="experiment-button-row">
            <button type="button" id="import-splat">导入本地文件</button>
            <button type="button" id="reset-scene">恢复测试场景</button>
          </div>
          <input id="splat-file-input" type="file" accept=".ply,.splat,.ksplat" hidden />
          <p id="source-status" class="experiment-status">内置 16,000 点测试场景</p>
          <label class="experiment-field">
            <span>生成规模</span>
            <select id="splat-scale">
              <option value="16000">16K 轻量</option>
              <option value="100000">100K 中等</option>
              <option value="250000">250K 大场景</option>
              <option value="1000000">1M 压力场景</option>
            </select>
          </label>
          <label class="experiment-field">
            <span>测试格式</span>
            <select id="splat-format">
              <option value="splat">SPLAT</option>
              <option value="ply">PLY</option>
              <option value="ksplat">KSPLAT</option>
            </select>
          </label>
          <button type="button" id="generate-scene">生成并加载</button>
        </section>

        <section>
          <header><strong>表面与地面</strong><small>点击高斯画面选取空间位置</small></header>
          <p id="pick-status" class="experiment-status">尚未选择表面点</p>
          <div class="experiment-button-row">
            <button type="button" id="move-character" disabled>人物走到选点</button>
            <button type="button" id="add-proxy" disabled>选点添加代理盒</button>
          </div>
        </section>

        <section>
          <header><strong>代理碰撞</strong><small>高斯负责采样，盒体负责可靠阻挡</small></header>
          <label class="experiment-switch"><input id="collision-toggle" type="checkbox" checked /><span>启用人物碰撞</span></label>
          <label class="experiment-switch"><input id="proxy-toggle" type="checkbox" checked /><span>显示代理盒</span></label>
          <button type="button" id="clear-proxy">清空代理盒</button>
          <p id="collision-status" class="experiment-status">已启用 1 个默认代理盒</p>
        </section>

        <section>
          <header><strong>性能基准</strong><small>固定采样 6 秒，可导出匿名结果</small></header>
          <div class="experiment-button-row">
            <button type="button" id="run-benchmark">开始测试</button>
            <button type="button" id="download-report" disabled>下载报告</button>
          </div>
          <p id="benchmark-status" class="experiment-status">等待测试</p>
        </section>
      </aside>

      <div class="experiment-viewport" id="experiment-viewport"></div>
      <div class="experiment-metrics" aria-label="实验实时指标">
        ${metric("Splat 数量", "准备中", "metric-count")}
        ${metric("源数据", "准备中", "metric-bytes")}
        ${metric("加载耗时", "准备中", "metric-load")}
        ${metric("实时帧率", "采样中", "metric-fps")}
        ${metric("估算内存", "准备中", "metric-memory")}
      </div>
    </section>
  `;

  return {
    viewport: requireChild(root, "#experiment-viewport"),
    fileInput: requireChild(root, "#splat-file-input"),
    importButton: requireChild(root, "#import-splat"),
    resetSceneButton: requireChild(root, "#reset-scene"),
    scaleSelect: requireChild(root, "#splat-scale"),
    formatSelect: requireChild(root, "#splat-format"),
    generateButton: requireChild(root, "#generate-scene"),
    resetViewButton: requireChild(root, "#reset-view"),
    rotateButton: requireChild(root, "#toggle-rotation"),
    exportButton: requireChild(root, "#export-frame"),
    moveCharacterButton: requireChild(root, "#move-character"),
    addProxyButton: requireChild(root, "#add-proxy"),
    clearProxyButton: requireChild(root, "#clear-proxy"),
    collisionToggle: requireChild(root, "#collision-toggle"),
    proxyToggle: requireChild(root, "#proxy-toggle"),
    benchmarkButton: requireChild(root, "#run-benchmark"),
    reportButton: requireChild(root, "#download-report"),
    sourceStatus: requireChild(root, "#source-status"),
    pickStatus: requireChild(root, "#pick-status"),
    collisionStatus: requireChild(root, "#collision-status"),
    benchmarkStatus: requireChild(root, "#benchmark-status"),
    countOutput: requireChild(root, "#metric-count"),
    bytesOutput: requireChild(root, "#metric-bytes"),
    loadOutput: requireChild(root, "#metric-load"),
    fpsOutput: requireChild(root, "#metric-fps"),
    memoryOutput: requireChild(root, "#metric-memory"),
  };
}
