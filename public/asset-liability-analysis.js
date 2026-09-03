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
  const positive = (items || []).filter(item => Number(item.amount) > 0).map(item => ({ ...item, amount: Number(item.amount) })).sort((a, b) => b.amount - a.amount);
  const total = positive.reduce((sum, item) => sum + item.amount, 0);
  let offset = 0;
  return positive.map((item, index) => {
    const percent = total > 0 ? item.amount / total * 100 : 0;
    const segment = { ...item, percent, offset, color: chartPalette[index % chartPalette.length] };
    offset += percent;
    return segment;
  });
};

const ensureStylesheet = () => {
  for (const fileName of ['asset-liability-analysis.css', 'asset-liability-analysis-layout.css']) {
    if (document.querySelector(`link[data-asset-liability-analysis-style="${fileName}"]`)) continue;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(`./${fileName}`, import.meta.url).href; link.dataset.assetLiabilityAnalysisStyle = fileName; document.head.append(link);
  }
};

export const assetLiabilityAnalysisButtonHtml = () => `<button class="button asset-liability-analysis-trigger" id="asset-liability-analysis-open" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3M3 21h18"/></svg><span><small>关键数据</small>资产负债分析</span></button>`;

const donutHtml = (section, heading, eyebrow) => {
  const segments = assetLiabilityChartSegments(section?.items);
  const circles = segments.map(segment => `<circle pathLength="100" cx="60" cy="60" r="46" fill="none" stroke="${segment.color}" stroke-width="15" stroke-dasharray="${segment.percent.toFixed(4)} ${(100 - segment.percent).toFixed(4)}" stroke-dashoffset="${(-segment.offset).toFixed(4)}"><title>${escapeHtml(segment.label)}：${amountText(segment.amount)} 元（${segment.percent.toFixed(1)}%）</title></circle>`).join('');
  const legend = segments.map(segment => `<li><i style="--legend-color:${segment.color}"></i><span><strong>${escapeHtml(segment.label)}</strong><small>${amountText(segment.amount)} 元</small></span><b>${segment.percent.toFixed(1)}%</b></li>`).join('');
  return `<section class="asset-liability-chart-card"><header><div><span>${escapeHtml(eyebrow)}</span><h3>${escapeHtml(heading)}</h3></div><strong>${amountText(section?.total)} <small>元</small></strong></header><div class="asset-liability-chart-content"><div class="asset-liability-donut"><svg viewBox="0 0 120 120" role="img" aria-label="${escapeHtml(heading)}占比图"><circle cx="60" cy="60" r="46" fill="none" stroke="#e8eef4" stroke-width="15"/>${circles}</svg><div><small>合计</small><strong>${compactAmountText(section?.total)}</strong><span>人民币</span></div></div><ol class="asset-liability-legend">${legend || '<li class="empty">暂无正数项目可绘制</li>'}</ol></div></section>`;
};

const statusHtml = data => {
  if (!data.available) return '<span class="missing">源表未提供分析区</span>';
  if (!data.complete) return '<span class="warning">数据待补全</span>';
  return data.balanced ? '<span class="balanced">勾稽一致</span>' : '<span class="unbalanced">存在差额</span>';
};

const analysisHtml = (data, versionChanged) => {
  if (!data.available) return `<div class="asset-liability-empty"><i>◇</i><h3>当前发布版本没有可识别的资产负债分析</h3><p>请确认资产负债表工作表中包含“钱的来源”和“钱的去向”项目/金额表。重新上传并发布后，此处会自动读取新版本。</p>${(data.warnings || []).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
  const sourceCount = data.source?.items?.length || 0; const destinationCount = data.destination?.items?.length || 0; const scale = Math.max(Number(data.source?.total || 0), Number(data.destination?.total || 0));
  const warnings = (data.warnings || []).length ? `<div class="asset-liability-warnings">${data.warnings.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '';
  const changed = versionChanged ? '<div class="asset-liability-version-change">已检测并切换到最新发布版本</div>' : '';
  return `${changed}<section class="asset-liability-metrics"><article><span>资金规模</span><strong>${amountText(scale)}</strong><small>元 · 以两侧较大合计展示</small></article><article><span>资金来源项目</span><strong>${sourceCount}</strong><small>项 · ${escapeHtml(data.source?.items?.[0]?.label || '暂无项目')}</small></article><article><span>资金去向项目</span><strong>${destinationCount}</strong><small>项 · ${escapeHtml(data.destination?.items?.[0]?.label || '暂无项目')}</small></article><article class="${data.balanced ? 'is-balanced' : 'has-difference'}"><span>来源与去向差额</span><strong>${amountText(Math.abs(Number(data.difference || 0)))}</strong><small>元 · ${data.balanced ? '两侧合计一致' : '建议复核源表合计'}</small></article></section>${warnings}<div class="asset-liability-chart-grid">${donutHtml(data.source, '钱的来源', '负债、资产与权益构成')}${donutHtml(data.destination, '钱的去向', '资金当前分布')}</div>`;
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
    root.innerHTML = `<section class="asset-liability-dialog"><header><div><span>当前发布版本 · 自动映射</span><h2 id="asset-liability-modal-title">资产负债分析</h2><p id="asset-liability-modal-sub">${escapeHtml(companyName || companyKey)} · ${escapeHtml(period)} · 正在读取发布数据</p></div><div class="asset-liability-dialog-actions"><button class="button" id="asset-liability-analysis-refresh" type="button">刷新分析</button><button class="asset-liability-close" type="button" aria-label="关闭资产负债分析">×</button></div></header><div class="asset-liability-status" id="asset-liability-analysis-status"><span class="loading">正在映射源表数据…</span></div><div class="asset-liability-body" id="asset-liability-analysis-body"><div class="asset-liability-loading"><i></i><span>正在生成关键数据卡片与图表</span></div></div><footer><span>映射规则 v1 · 数据随当前已发布报表即时重算</span><span id="asset-liability-analysis-time"></span></footer></section>`;
    document.body.append(root); document.body.classList.add('asset-liability-dialog-open');
    const closeButton = root.querySelector('.asset-liability-close'); const refreshButton = root.querySelector('#asset-liability-analysis-refresh'); const body = root.querySelector('#asset-liability-analysis-body'); const status = root.querySelector('#asset-liability-analysis-status'); const subtitle = root.querySelector('#asset-liability-modal-sub'); const refreshedAt = root.querySelector('#asset-liability-analysis-time');
    let requestNumber = 0; let lastUploadKey = renderedUploadKey;
    const load = async ({ quiet = false } = {}) => {
      const currentRequest = ++requestNumber;
      refreshButton.disabled = true; if (!quiet) status.innerHTML = '<span class="loading">正在同步当前发布版本…</span>';
      try {
        const data = await api(`/api/reports/balance_sheet/analysis?company=${encodeURIComponent(companyKey)}&period=${encodeURIComponent(period)}`);
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        const versionChanged = Boolean(lastUploadKey && data.meta?.uploadKey && lastUploadKey !== data.meta.uploadKey); lastUploadKey = data.meta?.uploadKey || lastUploadKey;
        body.innerHTML = analysisHtml(data, versionChanged); status.innerHTML = statusHtml(data);
        subtitle.textContent = `${data.company || companyName || companyKey} · ${data.period || period} · ${data.meta?.version ? `发布版本 v${data.meta.version}` : '当前发布批次'} · ${data.sourceSheet || '资产负债表'}`;
        refreshedAt.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } catch (error) {
        if (!activeDialog || activeDialog.root !== root || currentRequest !== requestNumber) return;
        status.innerHTML = '<span class="unbalanced">读取失败</span>'; body.innerHTML = `<div class="asset-liability-empty"><i>!</i><h3>暂时无法生成资产负债分析</h3><p>${escapeHtml(error.message || '请稍后重试')}</p><button class="button primary" id="asset-liability-analysis-retry" type="button">重新读取</button></div>`; root.querySelector('#asset-liability-analysis-retry')?.addEventListener('click', () => load());
      } finally {
        if (activeDialog?.root === root && currentRequest === requestNumber) refreshButton.disabled = false;
      }
    };
    const onKeydown = event => { if (event.key === 'Escape') closeAssetLiabilityAnalysis(); };
    closeButton.onclick = closeAssetLiabilityAnalysis; refreshButton.onclick = () => load(); root.onclick = event => { if (event.target === root) closeAssetLiabilityAnalysis(); }; document.addEventListener('keydown', onKeydown);
    activeDialog = { root, opener, onKeydown, timer: setInterval(() => load({ quiet: true }), 60000), connectionTimer: setInterval(() => { if (!opener.isConnected) closeAssetLiabilityAnalysis(); }, 1000) };
    closeButton.focus(); load();
  };
};
