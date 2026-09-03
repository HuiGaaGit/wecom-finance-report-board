const chartPalette = ['#2878c8', '#28a981', '#f1ae3b', '#e66a5c', '#745ac8', '#40a6b8', '#e38aa7', '#7e93aa', '#9acb56', '#cf7b38'];
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

const ensureStylesheet = () => {
  for (const fileName of ['asset-liability-analysis.css', 'asset-liability-analysis-layout.css']) {
    if (document.querySelector(`link[data-asset-liability-analysis-style="${fileName}"]`)) continue;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(`./${fileName}`, import.meta.url).href; link.dataset.assetLiabilityAnalysisStyle = fileName; document.head.append(link);
  }
};

export const assetLiabilityAnalysisButtonHtml = () => `<button class="button asset-liability-analysis-trigger" id="asset-liability-analysis-open" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3M3 21h18"/></svg><span><small>关键数据</small>资产负债分析</span></button>`;

const analysisSectionHtml = (section, heading, eyebrow, side) => {
  const segments = assetLiabilityChartSegments(section?.items);
  const segmentByIndex = new Map(segments.map(segment => [segment.originalIndex, segment]));
  const rows = assetLiabilityTableRows(section?.items).map(row => {
    const segment = segmentByIndex.get(row.originalIndex); const amount = row.amountAvailable === false ? (row.sourceValue || '—') : amountText(row.amount);
    const interactive = segment ? ` class="is-selectable" role="button" tabindex="0" data-analysis-segment="${side}:${segment.segmentId}" aria-label="查看${escapeHtml(row.label)}占比 ${segment.percent.toFixed(1)}%" aria-selected="false"` : ' class="is-static"';
    return `<tr${interactive}><td>${segment ? `<i style="--item-color:${segment.color}"></i>` : '<i class="is-empty"></i>'}<span>${escapeHtml(row.label)}</span></td><td>${escapeHtml(amount)}</td></tr>`;
  }).join('');
  const circles = segments.map(segment => `<circle class="asset-liability-segment" data-analysis-segment="${side}:${segment.segmentId}" data-label="${escapeHtml(segment.label)}" data-amount="${escapeHtml(amountText(segment.amount))}" data-percent="${segment.percent.toFixed(1)}" role="button" tabindex="0" aria-label="${escapeHtml(segment.label)}，${segment.percent.toFixed(1)}%" pathLength="100" cx="60" cy="60" r="46" fill="none" stroke="${segment.color}" stroke-width="15" stroke-dasharray="${segment.percent.toFixed(4)} ${(100 - segment.percent).toFixed(4)}" stroke-dashoffset="${(-segment.offset).toFixed(4)}"><title>${escapeHtml(segment.label)}：${amountText(segment.amount)} 元（${segment.percent.toFixed(1)}%）</title></circle>`).join('');
  return `<section class="asset-liability-analysis-card" data-analysis-side="${side}"><header><div><span>${escapeHtml(eyebrow)}</span><h3>${escapeHtml(section?.title || heading)}</h3></div><strong>${amountText(section?.total)} <small>元</small></strong></header><div class="asset-liability-source-table"><table><thead><tr><th>项目</th><th>金额</th></tr></thead><tbody>${rows || '<tr class="is-static"><td colspan="2">暂无项目</td></tr>'}</tbody><tfoot><tr><th>合计</th><th>${amountText(section?.total)}</th></tr></tfoot></table></div><div class="asset-liability-chart-heading"><span>${escapeHtml(heading)}构成</span><small>点击上方项目查看占比</small></div><div class="asset-liability-donut"><svg viewBox="0 0 120 120" role="img" aria-label="${escapeHtml(heading)}占比图"><circle cx="60" cy="60" r="46" fill="none" stroke="#e8eef4" stroke-width="15"/>${circles}</svg><div aria-live="polite"><small data-analysis-center-label>合计</small><strong data-analysis-center-value>${compactAmountText(section?.total)}</strong><span data-analysis-center-detail>人民币</span></div></div>${segments.length ? '' : '<p class="asset-liability-chart-empty">暂无正数项目可绘制</p>'}</section>`;
};

const analysisHtml = (data, versionChanged) => {
  if (!data.available) return `<div class="asset-liability-empty"><i>◇</i><h3>当前发布版本没有可识别的资产负债分析</h3><p>请确认资产负债表工作表中包含“钱的来源”和“钱的去向”项目/金额表。重新上传并发布后，此处会自动读取新版本。</p>${(data.warnings || []).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
  const warnings = (data.warnings || []).length ? `<div class="asset-liability-warnings">${data.warnings.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '';
  const changed = versionChanged ? '<div class="asset-liability-version-change">已检测并切换到最新发布版本</div>' : '';
  return `${changed}<div class="asset-liability-analysis-grid">${analysisSectionHtml(data.source, '钱的来源', '源表项目与金额', 'source')}${analysisSectionHtml(data.destination, '钱的去向', '源表项目与金额', 'destination')}</div>${warnings}`;
};

const activateAnalysisSegment = (root, target) => {
  const token = target?.dataset?.analysisSegment; if (!token) return;
  const side = token.split(':')[0]; const card = [...root.querySelectorAll('[data-analysis-side]')].find(item => item.dataset.analysisSide === side); if (!card) return;
  let activeCircle = null;
  card.querySelectorAll('[data-analysis-segment]').forEach(item => {
    const active = item.dataset.analysisSegment === token; item.classList.toggle('is-active', active);
    if (item.tagName === 'TR') item.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active && item.tagName === 'circle') activeCircle = item;
  });
  if (!activeCircle) return;
  card.classList.add('has-active'); activeCircle.classList.remove('is-pulsing'); requestAnimationFrame(() => activeCircle.classList.add('is-pulsing'));
  card.querySelector('[data-analysis-center-label]').textContent = activeCircle.dataset.label;
  card.querySelector('[data-analysis-center-value]').textContent = `${activeCircle.dataset.percent}%`;
  card.querySelector('[data-analysis-center-detail]').textContent = `${activeCircle.dataset.amount} 元`;
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
      const currentRequest = ++requestNumber;
      refreshButton.disabled = true; if (!quiet && !body.querySelector('.asset-liability-analysis-grid')) body.innerHTML = '<div class="asset-liability-loading"><i></i><span>正在同步当前发布版本…</span></div>';
      try {
        const data = await api(`/api/reports/balance_sheet/analysis?company=${encodeURIComponent(companyKey)}&period=${encodeURIComponent(period)}`);
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        const versionChanged = Boolean(lastUploadKey && data.meta?.uploadKey && lastUploadKey !== data.meta.uploadKey); lastUploadKey = data.meta?.uploadKey || lastUploadKey;
        body.innerHTML = analysisHtml(data, versionChanged);
        subtitle.textContent = `${data.company || companyName || companyKey} · ${data.period || period} · ${data.meta?.version ? `发布版本 v${data.meta.version}` : '当前发布批次'} · ${data.sourceSheet || '资产负债表'}`;
        refreshedAt.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } catch (error) {
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        body.innerHTML = `<div class="asset-liability-empty"><i>!</i><h3>暂时无法生成资产负债分析</h3><p>${escapeHtml(error.message || '请稍后重试')}</p><button class="button primary" id="asset-liability-analysis-retry" type="button">重新读取</button></div>`; root.querySelector('#asset-liability-analysis-retry')?.addEventListener('click', () => load());
      } finally {
        if (activeDialog?.root === root && currentRequest === requestNumber) refreshButton.disabled = false;
      }
    };
    const onKeydown = event => { if (event.key === 'Escape') return closeAssetLiabilityAnalysis(); if ((event.key === 'Enter' || event.key === ' ') && event.target?.dataset?.analysisSegment) { event.preventDefault(); activateAnalysisSegment(root, event.target); } };
    root.addEventListener('click', event => activateAnalysisSegment(root, event.target.closest?.('[data-analysis-segment]')));
    closeButton.onclick = closeAssetLiabilityAnalysis; refreshButton.onclick = () => load(); root.onclick = event => { if (event.target === root) closeAssetLiabilityAnalysis(); }; document.addEventListener('keydown', onKeydown);
    activeDialog = { root, opener, onKeydown, timer: setInterval(() => load({ quiet: true }), 60000), connectionTimer: setInterval(() => { if (!opener.isConnected) closeAssetLiabilityAnalysis(); }, 1000) };
    closeButton.focus(); load();
  };
};
