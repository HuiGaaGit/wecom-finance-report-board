const chartPalette = ['#2878c8', '#28a981', '#f1ae3b', '#e66a5c', '#745ac8', '#40a6b8', '#e38aa7', '#7e93aa', '#9acb56', '#cf7b38', '#4c6bd7', '#37b8a0', '#d8b72e', '#db5870', '#8f6fce', '#2f8eab', '#b9659b', '#6b8b5e'];
let activeDialog = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const amountText = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactAmountText = value => {
  const amount = Number(value || 0); const absolute = Math.abs(amount);
  if (absolute >= 100000000) return `${(amount / 100000000).toFixed(absolute >= 1000000000 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/g, '')}亿`;
  if (absolute >= 10000) return `${(amount / 10000).toFixed(absolute >= 1000000 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/g, '')}万`;
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
};

export const assetLiabilityChartSegments = items => {
  const positive = (items || []).map((item, originalIndex) => ({ ...item, amount: Number(item.amount), originalIndex })).filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = positive.reduce((sum, item) => sum + item.amount, 0);
  let offset = 0;
  return positive.map((item, index) => {
    const percent = total > 0 ? item.amount / total * 100 : 0;
    const segment = { ...item, segmentId: `item-${item.originalIndex}`, percent, offset, color: chartPalette[index % chartPalette.length] };
    offset += percent;
    return segment;
  });
};

export const assetLiabilityTableRows = items => {
  const segments = assetLiabilityChartSegments(items); const segmentByIndex = new Map(segments.map(segment => [segment.originalIndex, segment]));
  return (items || []).map((item, originalIndex) => {
    const segment = segmentByIndex.get(originalIndex);
    return { ...item, originalIndex, segmentId: segment?.segmentId || '', percent: segment?.percent || 0, selectable: Boolean(segment) };
  });
};

export const assetLiabilityChartLabels = segments => {
  const centerX = 350; const centerY = 230; const arcRadius = 148; const elbowRadius = 170; const top = 34; const bottom = 426; const gap = 29;
  const labels = (segments || []).map(segment => {
    const angle = (-90 + (segment.offset + segment.percent / 2) * 3.6) * Math.PI / 180; const cosine = Math.cos(angle); const sine = Math.sin(angle); const side = cosine >= 0 ? 'right' : 'left';
    return { ...segment, side, angle, rawY: centerY + sine * elbowRadius, arcX: centerX + cosine * arcRadius, arcY: centerY + sine * arcRadius, elbowX: centerX + cosine * elbowRadius, elbowY: centerY + sine * elbowRadius };
  });
  for (const side of ['left', 'right']) {
    const sideLabels = labels.filter(label => label.side === side).sort((a, b) => a.rawY - b.rawY); const count = sideLabels.length;
    const sideGap = count > 1 ? Math.min(gap, (bottom - top) / (count - 1)) : 0;
    sideLabels.forEach((label, index) => { label.labelY = Math.max(top, Math.min(bottom, label.rawY)); if (index) label.labelY = Math.max(label.labelY, sideLabels[index - 1].labelY + sideGap); });
    for (let index = count - 1; index >= 0; index -= 1) sideLabels[index].labelY = Math.min(sideLabels[index].labelY, index === count - 1 ? bottom : sideLabels[index + 1].labelY - sideGap);
    sideLabels.forEach(label => { label.labelX = side === 'right' ? 674 : 26; label.lineX = side === 'right' ? 660 : 40; label.jointX = side === 'right' ? 520 : 180; });
  }
  return labels;
};

const shortLabel = value => { const characters = Array.from(String(value || '')); return characters.length > 18 ? `${characters.slice(0, 17).join('')}…` : characters.join(''); };

const ensureStylesheet = () => {
  for (const fileName of ['asset-liability-analysis.css', 'asset-liability-analysis-layout.css']) {
    if (document.querySelector(`link[data-asset-liability-analysis-style="${fileName}"]`)) continue;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(`./${fileName}`, import.meta.url).href; link.dataset.assetLiabilityAnalysisStyle = fileName; document.head.append(link);
  }
};

export const assetLiabilityAnalysisButtonHtml = () => `<button class="button asset-liability-analysis-trigger" id="asset-liability-analysis-open" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3M3 21h18"/></svg><span><small>关键数据</small>资产负债分析</span></button>`;

const analysisTablePanelHtml = (section, side) => {
  const segments = assetLiabilityChartSegments(section?.items);
  const segmentByIndex = new Map(segments.map(segment => [segment.originalIndex, segment]));
  const rows = assetLiabilityTableRows(section?.items).map(row => {
    const segment = segmentByIndex.get(row.originalIndex); const amount = row.amountAvailable === false ? (row.sourceValue || '—') : amountText(row.amount);
    const interactive = segment ? ` class="is-selectable" role="button" tabindex="0" data-analysis-segment="${side}:${segment.segmentId}" aria-label="查看${escapeHtml(row.label)}占比 ${segment.percent.toFixed(1)}%" aria-selected="false"` : ' class="is-static"';
    return `<tr${interactive}><td>${segment ? `<i style="--item-color:${segment.color}"></i>` : '<i class="is-empty"></i>'}<span>${escapeHtml(row.label)}</span></td><td>${escapeHtml(amount)}</td></tr>`;
  }).join('');
  return `<section class="asset-liability-table-panel" data-analysis-side="${side}"><header><h3>${escapeHtml(section?.title || '')}</h3><strong>${amountText(section?.total)} <small>元</small></strong></header><div class="asset-liability-source-table"><table><colgroup><col><col></colgroup><thead><tr><th>项目</th><th>金额</th></tr></thead><tbody>${rows || '<tr class="is-static"><td colspan="2">暂无项目</td></tr>'}</tbody><tfoot><tr><th>合计</th><th>${amountText(section?.total)}</th></tr></tfoot></table></div></section>`;
};

const analysisChartPanelHtml = (section, heading, side) => {
  const segments = assetLiabilityChartSegments(section?.items); const labels = assetLiabilityChartLabels(segments);
  const circles = segments.map(segment => `<circle class="asset-liability-segment" data-analysis-segment="${side}:${segment.segmentId}" data-label="${escapeHtml(segment.label)}" data-amount="${escapeHtml(amountText(segment.amount))}" data-percent="${segment.percent.toFixed(1)}" role="button" tabindex="0" aria-label="${escapeHtml(segment.label)}，${segment.percent.toFixed(1)}%" pathLength="100" cx="350" cy="230" r="128" fill="none" stroke="${segment.color}" stroke-width="34" stroke-dasharray="${segment.percent.toFixed(4)} ${(100 - segment.percent).toFixed(4)}" stroke-dashoffset="${(-segment.offset).toFixed(4)}"><title>${escapeHtml(segment.label)}：${amountText(segment.amount)} 元（${segment.percent.toFixed(1)}%）</title></circle>`).join('');
  const directLabels = labels.map(label => {
    const anchor = label.side === 'right' ? 'end' : 'start'; const token = `${side}:${label.segmentId}`;
    return `<g class="asset-liability-direct-label" data-analysis-segment="${token}" role="button" tabindex="0" aria-label="${escapeHtml(label.label)}，${label.percent.toFixed(1)}%"><polyline class="asset-liability-label-line" points="${label.arcX.toFixed(1)},${label.arcY.toFixed(1)} ${label.elbowX.toFixed(1)},${label.elbowY.toFixed(1)} ${label.jointX},${label.labelY.toFixed(1)} ${label.lineX},${label.labelY.toFixed(1)}" style="--item-color:${label.color}"/><circle class="asset-liability-label-dot" cx="${label.lineX}" cy="${label.labelY.toFixed(1)}" r="3" fill="${label.color}"/><text x="${label.labelX}" y="${(label.labelY - 3).toFixed(1)}" text-anchor="${anchor}"><tspan class="asset-liability-label-name">${escapeHtml(shortLabel(label.label))}</tspan><tspan class="asset-liability-label-percent" x="${label.labelX}" dy="15">${label.percent.toFixed(1)}%</tspan></text></g>`;
  }).join('');
  return `<section class="asset-liability-chart-panel" data-analysis-side="${side}"><header><div><span>${escapeHtml(heading)}构成</span><h3>${escapeHtml(section?.title || heading)}</h3></div><strong>${amountText(section?.total)} <small>元</small></strong></header><div class="asset-liability-chart-viewport"><div class="asset-liability-donut"><svg class="asset-liability-chart-svg" viewBox="0 0 700 460" role="img" aria-label="${escapeHtml(heading)}占比图"><circle cx="350" cy="230" r="128" fill="none" stroke="#e8eef4" stroke-width="34"/><g transform="rotate(-90 350 230)">${circles}</g>${directLabels}</svg><div aria-live="polite"><small data-analysis-center-label>合计</small><strong data-analysis-center-value>${compactAmountText(section?.total)}</strong><span data-analysis-center-detail>人民币</span></div></div></div>${segments.length ? '' : '<p class="asset-liability-chart-empty">暂无正数项目可绘制</p>'}</section>`;
};

const analysisHtml = (data, versionChanged) => {
  if (!data.available) return `<div class="asset-liability-empty"><i>◇</i><h3>当前发布版本没有可识别的资产负债分析</h3><p>请确认资产负债表工作表中包含“钱的来源”和“钱的去向”项目/金额表。重新上传并发布后，此处会自动读取新版本。</p>${(data.warnings || []).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
  const warnings = (data.warnings || []).length ? `<div class="asset-liability-warnings">${data.warnings.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '';
  const changed = versionChanged ? '<div class="asset-liability-version-change">已检测并切换到最新发布版本</div>' : '';
  return `${changed}<section class="asset-liability-switcher" data-analysis-view="source"><div class="asset-liability-tabs" role="tablist" aria-label="资产负债分析分类"><button class="is-active" type="button" role="tab" id="asset-liability-tab-source" aria-selected="true" aria-controls="asset-liability-table-source" data-analysis-switch="source">钱的来源</button><button type="button" role="tab" id="asset-liability-tab-destination" aria-selected="false" aria-controls="asset-liability-table-destination" data-analysis-switch="destination" tabindex="-1">钱的去向</button><i aria-hidden="true"></i></div><div class="asset-liability-workspace"><div class="asset-liability-table-stage"><div class="asset-liability-table-rail"><div id="asset-liability-table-source" class="asset-liability-rail-panel" role="tabpanel" aria-labelledby="asset-liability-tab-source">${analysisTablePanelHtml(data.source, 'source')}</div><div id="asset-liability-table-destination" class="asset-liability-rail-panel" role="tabpanel" aria-labelledby="asset-liability-tab-destination" aria-hidden="true" inert>${analysisTablePanelHtml(data.destination, 'destination')}</div></div></div><div class="asset-liability-chart-stage"><div class="asset-liability-chart-rail"><div class="asset-liability-rail-panel">${analysisChartPanelHtml(data.source, '钱的来源', 'source')}</div><div class="asset-liability-rail-panel" aria-hidden="true" inert>${analysisChartPanelHtml(data.destination, '钱的去向', 'destination')}</div></div></div></div></section>${warnings}`;
};

const activateAnalysisSegment = (root, target) => {
  const token = target?.dataset?.analysisSegment; if (!token) return;
  const side = token.split(':')[0]; const switcher = root.querySelector('.asset-liability-switcher'); if (!switcher) return;
  const panels = [...switcher.querySelectorAll('[data-analysis-side]')].filter(item => item.dataset.analysisSide === side); if (!panels.length) return;
  let activeCircle = null;
  panels.forEach(panel => panel.querySelectorAll('[data-analysis-segment]').forEach(item => {
    const active = item.dataset.analysisSegment === token; item.classList.toggle('is-active', active);
    if (item.tagName === 'TR') item.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active && item.tagName === 'circle') activeCircle = item;
  }));
  if (!activeCircle) return;
  const chartPanel = panels.find(panel => panel.classList.contains('asset-liability-chart-panel')); if (!chartPanel) return;
  chartPanel.classList.add('has-active'); activeCircle.classList.remove('is-pulsing'); requestAnimationFrame(() => activeCircle.classList.add('is-pulsing'));
  chartPanel.querySelector('[data-analysis-center-label]').textContent = activeCircle.dataset.label;
  chartPanel.querySelector('[data-analysis-center-value]').textContent = `${activeCircle.dataset.percent}%`;
  chartPanel.querySelector('[data-analysis-center-detail]').textContent = `${activeCircle.dataset.amount} 元`;
};

const switchAnalysisView = (root, side, focusTab = false) => {
  if (!['source', 'destination'].includes(side)) return;
  const switcher = root.querySelector('.asset-liability-switcher'); if (!switcher) return;
  switcher.dataset.analysisView = side;
  switcher.querySelectorAll('[data-analysis-switch]').forEach(tab => {
    const active = tab.dataset.analysisSwitch === side; tab.classList.toggle('is-active', active); tab.setAttribute('aria-selected', active ? 'true' : 'false'); tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus();
  });
  switcher.querySelectorAll('.asset-liability-table-rail > .asset-liability-rail-panel, .asset-liability-chart-rail > .asset-liability-rail-panel').forEach((panel, index) => { const active = index % 2 === (side === 'source' ? 0 : 1); panel.setAttribute('aria-hidden', active ? 'false' : 'true'); panel.inert = !active; });
};

export const closeAssetLiabilityAnalysis = () => {
  if (!activeDialog) return;
  clearInterval(activeDialog.timer); clearInterval(activeDialog.connectionTimer);
  document.removeEventListener('keydown', activeDialog.onKeydown);
  activeDialog.root.remove(); document.body.classList.remove('asset-liability-dialog-open');
  if (activeDialog.opener?.isConnected) activeDialog.opener.focus();
  activeDialog = null;
};

export const bindAssetLiabilityAnalysis = ({ api, companyKey, companyName, period, renderedUploadKey = '' }) => {
  ensureStylesheet();
  const opener = document.querySelector('#asset-liability-analysis-open');
  if (!opener) return;
  opener.onclick = () => {
    closeAssetLiabilityAnalysis();
    const root = document.createElement('div'); root.className = 'asset-liability-modal'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'asset-liability-modal-title');
    root.innerHTML = `<section class="asset-liability-dialog"><header><div><span>当前发布版本 · 自动映射</span><h2 id="asset-liability-modal-title">资产负债分析</h2><p id="asset-liability-modal-sub">${escapeHtml(companyName || companyKey)} · ${escapeHtml(period)} · 正在读取发布数据</p></div><div class="asset-liability-dialog-actions"><button class="button" id="asset-liability-analysis-refresh" type="button">刷新分析</button><button class="asset-liability-close" type="button" aria-label="关闭资产负债分析">×</button></div></header><div class="asset-liability-body" id="asset-liability-analysis-body"><div class="asset-liability-loading"><i></i><span>正在还原源表明细与生成图表</span></div></div><footer><span>映射规则 v1 · 数据随当前已发布报表即时重算</span><span id="asset-liability-analysis-time"></span></footer></section>`;
    document.body.append(root); document.body.classList.add('asset-liability-dialog-open');
    const closeButton = root.querySelector('.asset-liability-close'); const refreshButton = root.querySelector('#asset-liability-analysis-refresh'); const body = root.querySelector('#asset-liability-analysis-body'); const subtitle = root.querySelector('#asset-liability-modal-sub'); const refreshedAt = root.querySelector('#asset-liability-analysis-time');
    let requestNumber = 0; let lastUploadKey = renderedUploadKey;
    const load = async ({ quiet = false } = {}) => {
      const currentRequest = ++requestNumber; const selectedView = body.querySelector('.asset-liability-switcher')?.dataset.analysisView || 'source';
      refreshButton.disabled = true; if (!quiet && !body.querySelector('.asset-liability-switcher')) body.innerHTML = '<div class="asset-liability-loading"><i></i><span>正在同步当前发布版本…</span></div>';
      try {
        const data = await api(`/api/reports/balance_sheet/analysis?company=${encodeURIComponent(companyKey)}&period=${encodeURIComponent(period)}`);
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        const versionChanged = Boolean(lastUploadKey && data.meta?.uploadKey && lastUploadKey !== data.meta.uploadKey); lastUploadKey = data.meta?.uploadKey || lastUploadKey;
        body.innerHTML = analysisHtml(data, versionChanged); switchAnalysisView(root, selectedView);
        subtitle.textContent = `${data.company || companyName || companyKey} · ${data.period || period} · ${data.meta?.version ? `发布版本 v${data.meta.version}` : '当前发布批次'} · ${data.sourceSheet || '资产负债表'}`;
        refreshedAt.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } catch (error) {
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        body.innerHTML = `<div class="asset-liability-empty"><i>!</i><h3>暂时无法生成资产负债分析</h3><p>${escapeHtml(error.message || '请稍后重试')}</p><button class="button primary" id="asset-liability-analysis-retry" type="button">重新读取</button></div>`; root.querySelector('#asset-liability-analysis-retry')?.addEventListener('click', () => load());
      } finally {
        if (activeDialog?.root === root && currentRequest === requestNumber) refreshButton.disabled = false;
      }
    };
    const onKeydown = event => {
      if (event.key === 'Escape') return closeAssetLiabilityAnalysis();
      if ((event.key === 'Enter' || event.key === ' ') && event.target?.dataset?.analysisSegment) { event.preventDefault(); activateAnalysisSegment(root, event.target); return; }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target?.dataset?.analysisSwitch) { event.preventDefault(); switchAnalysisView(root, event.target.dataset.analysisSwitch === 'source' ? 'destination' : 'source', true); }
    };
    root.addEventListener('click', event => { const tab = event.target.closest?.('[data-analysis-switch]'); if (tab) switchAnalysisView(root, tab.dataset.analysisSwitch); else activateAnalysisSegment(root, event.target.closest?.('[data-analysis-segment]')); });
    closeButton.onclick = closeAssetLiabilityAnalysis; refreshButton.onclick = () => load(); root.onclick = event => { if (event.target === root) closeAssetLiabilityAnalysis(); }; document.addEventListener('keydown', onKeydown);
    activeDialog = { root, opener, onKeydown, timer: setInterval(() => load({ quiet: true }), 60000), connectionTimer: setInterval(() => { if (!opener.isConnected) closeAssetLiabilityAnalysis(); }, 1000) };
    closeButton.focus(); load();
  };
};
