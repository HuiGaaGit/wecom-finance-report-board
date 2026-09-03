import { renderPermissionCenter } from './permission-center.js';
import { assetLiabilityAnalysisButtonHtml, bindAssetLiabilityAnalysis } from './asset-liability-analysis.js';

const revenueProfitReportType = 'revenue_profit_consolidated_income_statement';
const financialBriefModuleKey = 'financial_brief';
const groupStatementReportTypes = new Set(['consolidated_income_statement', revenueProfitReportType]);
const reportPageTypes = ['balance_sheet', 'income_statement', 'consolidated_income_statement', revenueProfitReportType, 'cash_flow', 'trial_balance', 'journal'];
const revenueStatisticsReportType = 'revenue_statistics';
const payrollStatementReportType = 'payroll_statement';
const consultantRoiModuleKey = 'consultant_roi_analysis';
const intercompanyModuleKey = 'intercompany_reconciliation';
const activityLogModuleKey = 'activity_logs';
const revenueDimensions = [{ key: 'group', name: '集团维度' }, { key: 'direct', name: '单独直客维度' }, { key: 'channel', name: '单独渠道维度' }];
const state = { employeeKey: 'admin', bootstrap: null, page: 'home', reportType: 'balance_sheet', company: 'gz', period: '2026-06', periodExplicit: false, detailPeriod: '', detailAccountCodes: [], version: null, summary: null, raw: null, consolidatedEntityReportType: '', consolidatedEntitySheet: '', consolidatedExpanded: false, consolidatedScope: '', revenueDimension: 'group', revenueTable: 'B1', revenueExpanded: false };
const consultantRoiView = {
  inputs: { baseSalary: true, commission: true, journalExpense: true },
  filters: {},
  sortKey: 'output',
  sortDirection: 'desc'
};
let reportRequestRevision = 0;
let pageRequestRevision = 0;
const financialBriefAutoRefreshMs = 60_000;
let financialBriefRefreshTimer = null;
let financialBriefRefreshInFlight = false;
let financialBriefRequestRevision = 0;
const consultantRoiAutoRefreshMs = 60_000;
let consultantRoiRefreshTimer = null;
let consultantRoiRefreshInFlight = false;
let consultantRoiRequestRevision = 0;
let consultantRoiSourceRevision = '';
let uploadHistoryRequestRevision = 0;
let uploadHistoryMutationInFlight = false;
const appBasePath = document.querySelector('meta[name="app-base-path"]')?.content || '';
const expectedAppVersion = document.querySelector('meta[name="app-version"]')?.content || '';
const platformLoginUrl = document.querySelector('meta[name="platform-login-url"]')?.content || '/platform/login';
const platformAuthStorageKey = 'aqllm_tob_auth';
const platformReturnStorageKey = 'aqllm:safe-return-to';
const appUrl = url => `${appBasePath}${String(url).startsWith('/') ? url : `/${url}`}`;
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const reportNames = { balance_sheet: '资产负债表', income_statement: '利润表', consolidated_income_statement: '桉侨集团合并利润表', [revenueProfitReportType]: '（营收利润口径）合并利润表', [revenueStatisticsReportType]: '营收统计表', [payrollStatementReportType]: '每月工资表', cash_flow: '现金流量表', trial_balance: '科目余额表', journal: '序时账' };
const showNotice = (message, error = false) => { const box = $('#notice'); box.textContent = message; box.classList.toggle('error', error); box.classList.remove('hidden'); window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => box.classList.add('hidden'), 3500); };
const platformReturnPath = () => appBasePath.startsWith('/platform/') ? `${appBasePath.slice('/platform'.length)}/`.replace(/\/+/g, '/') : `${appBasePath || '/'}/`.replace(/\/+/g, '/');
const readPlatformAccessToken = () => {
  try {
    const auth = JSON.parse(localStorage.getItem(platformAuthStorageKey) || 'null');
    return typeof auth?.accessToken === 'string' && auth.accessToken.length <= 8192 ? auth.accessToken : '';
  } catch { return ''; }
};
const redirectToPlatformLogin = (forceRefresh = false) => {
  try { sessionStorage.setItem(platformReturnStorageKey, platformReturnPath()); } catch {}
  const target = new URL(platformLoginUrl, window.location.href);
  if (forceRefresh) target.searchParams.set('reauth', '1');
  window.location.assign(target.href);
};
let platformSessionPromise = null;
const ensurePlatformSession = () => {
  if (platformSessionPromise) return platformSessionPromise;
  platformSessionPromise = (async () => {
    const accessToken = readPlatformAccessToken();
    if (!accessToken) { redirectToPlatformLogin(); throw new Error('正在前往小Q登录'); }
    const exchange = token => fetch(appUrl('/api/auth/platform-session'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const response = await exchange(accessToken);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { redirectToPlatformLogin(true); throw new Error(payload.error || '小Q登录状态已失效'); }
    if (!response.ok) throw Object.assign(new Error(payload.error || `登录校验失败（${response.status}）`), { status: response.status });
    return payload;
  })().finally(() => { platformSessionPromise = null; });
  return platformSessionPromise;
};
const api = async (url, options = {}, authRetried = false) => {
  const headers = { ...(options.headers || {}) };
  if (state.bootstrap?.authMode === 'demo') headers['x-demo-employee'] = state.employeeKey;
  if (state.bootstrap?.authMode === 'platform' && url === '/api/admin/directory-sync') {
    const accessToken = readPlatformAccessToken();
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(appUrl(url), { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.loginUrl && !authRetried) { await ensurePlatformSession(); return api(url, options, true); }
  if (!response.ok) { const error = new Error(payload.error || `请求失败（${response.status}）`); Object.assign(error, payload, { status: response.status }); throw error; }
  return payload;
};
const assertCompatibleAppVersion = bootstrap => {
  if (!expectedAppVersion || bootstrap?.appVersion === expectedAppVersion) return bootstrap;
  const runtimeVersion = bootstrap?.appVersion ? `v${bootstrap.appVersion}` : '旧版服务';
  throw Object.assign(new Error(`页面版本 v${expectedAppVersion} 与后台 ${runtimeVersion} 不一致。请重启财务看板服务并刷新页面后再操作，当前页面已停止提交数据。`), { code: 'APP_VERSION_MISMATCH', expectedAppVersion, runtimeVersion: bootstrap?.appVersion || '' });
};
const setActiveNav = () => {
  document.querySelectorAll('.nav-item').forEach(item => {
    const entitySheet = item.dataset.entitySheet || '';
    const entityReportType = item.dataset.entityReportType || '';
    const revenueDimension = item.dataset.revenueDimension || '';
    const active = revenueDimension
      ? state.page === revenueStatisticsReportType && state.revenueDimension === revenueDimension
      : entitySheet
      ? state.page === entityReportType && state.consolidatedEntityReportType === entityReportType && state.consolidatedEntitySheet === entitySheet
      : item.dataset.page === state.page && !(groupStatementReportTypes.has(item.dataset.page) && state.consolidatedEntityReportType === item.dataset.page && state.consolidatedEntitySheet) && !(item.dataset.page === revenueStatisticsReportType && state.revenueDimension);
    item.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-item[data-page]').forEach(item => item.classList.toggle('has-active-child', groupStatementReportTypes.has(item.dataset.page) && state.page === item.dataset.page && state.consolidatedEntityReportType === item.dataset.page && Boolean(state.consolidatedEntitySheet)));
  document.querySelector(`.nav-item[data-page="${revenueStatisticsReportType}"]`)?.classList.toggle('has-active-child', state.page === revenueStatisticsReportType && Boolean(state.revenueDimension));
};
const pageHostFor = page => {
  if (page === 'home') return $('#home-page');
  if (page === financialBriefModuleKey) return $('#financial-brief-page');
  if (page === revenueStatisticsReportType) return $('#revenue-statistics-page');
  if (reportPageTypes.includes(page)) return $('#report-page');
  if (page === 'journal_detail') return $('#detail-page');
  if (page === 'permissions') return $('#permissions-page');
  if (page === activityLogModuleKey) return $('#activity-logs-page');
  if (page === 'uploads') return $('#uploads-page');
  if (page === 'database_admin') return $('#database-admin-page');
  if (page === 'cash_analysis') return $('#analysis-page');
  if (page === 'main_business_analysis') return $('#business-analysis-page');
  if (page === 'expense_analysis') return $('#expense-analysis-page');
  if (page === 'group_profit_analysis') return $('#group-profit-analysis-page');
  if (page === consultantRoiModuleKey) return $('#consultant-roi-analysis-page');
  if (page === intercompanyModuleKey) return $('#intercompany-reconciliation-page');
  return null;
};
const syncPageVisibility = () => {
  const activeHost = pageHostFor(state.page);
  document.querySelectorAll('.content > .page').forEach(page => { const hidden = page !== activeHost; page.classList.toggle('hidden', hidden); if (hidden) page.removeAttribute('aria-busy'); });
};
const restartPageArrival = () => {
  const activeHost = pageHostFor(state.page); if (!activeHost) return;
  activeHost.getAnimations?.().filter(animation => animation.id === 'page-arrival').forEach(animation => animation.cancel());
  if (window.matchMedia?.('(max-width: 900px)').matches || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const animation = activeHost.animate([{ opacity: .72, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 190, easing: 'cubic-bezier(.2,.78,.28,1)' });
  animation.id = 'page-arrival';
};
const navigateToPage = page => { state.page = page; state.version = null; syncPageVisibility(); setActiveNav(); refresh({ reloadBootstrap: false }); };
const openConsolidatedParent = reportType => {
  if (!groupStatementReportTypes.has(reportType)) return;
  const alreadyOpen = state.page === reportType && state.consolidatedEntityReportType === reportType && !state.consolidatedEntitySheet;
  state.consolidatedEntityReportType = reportType; state.consolidatedEntitySheet = '';
  state.consolidatedExpanded = alreadyOpen ? !state.consolidatedExpanded : true;
  renderNav();
  navigateToPage(reportType);
};
const openConsolidatedEntity = (reportType, sourceSheet) => {
  if (!(state.bootstrap?.consolidatedEntitiesByReport?.[reportType] || []).some(entity => entity.sourceSheet === sourceSheet)) return;
  state.consolidatedEntityReportType = reportType; state.consolidatedEntitySheet = sourceSheet; state.consolidatedExpanded = true;
  renderNav();
  navigateToPage(reportType);
};
const openRevenueParent = () => {
  const alreadyOpen = state.page === revenueStatisticsReportType;
  state.revenueDimension ||= 'group'; state.revenueExpanded = alreadyOpen ? !state.revenueExpanded : true;
  renderNav(); navigateToPage(revenueStatisticsReportType);
};
const openRevenueDimension = dimension => {
  if (!revenueDimensions.some(item => item.key === dimension)) return;
  state.revenueDimension = dimension; state.revenueExpanded = true; state.revenueTable = '';
  renderNav(); navigateToPage(revenueStatisticsReportType);
};
const revealActiveNav = nav => {
  if (!window.matchMedia?.('(max-width: 900px)').matches) return;
  const scroller = nav.closest('.sidebar'); const active = nav.querySelector('.nav-item.active');
  if (!scroller || !active) return;
  requestAnimationFrame(() => {
    const desired = active.offsetLeft - (scroller.clientWidth - active.offsetWidth) / 2;
    const left = Math.max(0, Math.min(desired, scroller.scrollWidth - scroller.clientWidth));
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ left, behavior: 'auto' });
    else scroller.scrollLeft = left;
  });
};
const currentCompanyName = () => state.bootstrap?.companies.find(item => item.key === state.company)?.name || (state.bootstrap?.companies?.length ? state.company : '未选择公司');
const sharePageNames = { home: '首页', [financialBriefModuleKey]: '财务数据简报', cash_analysis: '资产净额分析', main_business_analysis: '主营业务分析', expense_analysis: '费用分析', group_profit_analysis: '集团合并利润趋势图', [intercompanyModuleKey]: '各公司往来校验', uploads: '上传报表', [activityLogModuleKey]: '浏览日志', database_admin: '数据库管理', permissions: '权限管理', journal_detail: '序时账明细', ...reportNames };
const shareCardData = () => {
  const moduleName = sharePageNames[state.page] || '财务报表看板';
  const scope = state.bootstrap && state.page !== 'home' ? `${currentCompanyName()} · ${state.period}` : '企业微信安全访问';
  return {
    title: state.page === 'home' ? '桉侨集团财务报表看板' : `${moduleName} · 桉侨财务看板`,
    desc: `${scope}；打开后按接收人的企微权限显示`,
    link: new URL(appUrl('/'), window.location.origin).href,
    imgUrl: new URL(appUrl('/anqiao-logo.png'), window.location.origin).href
  };
};
const writeClipboardText = async text => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea'); input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select();
    const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('复制失败，请检查浏览器剪贴板权限');
  }
};
const copyShareLink = async () => {
  const { link } = shareCardData();
  await writeClipboardText(link);
  showNotice('分享链接已复制，可粘贴到企微聊天');
};
const sendShareCard = async () => {
  await copyShareLink(); $('#share-modal').classList.add('hidden');
};
function bindShareCard() {
  const modal = $('#share-modal'); const open = () => {
    const data = shareCardData(); const copyButton = $('#share-copy'); const actions = modal.querySelector('.share-actions');
    $('#share-card-title').textContent = data.title; $('#share-card-description').textContent = data.desc;
    $('#share-environment-note').textContent = '链接不携带登录凭证；接收人打开后需通过小Q企微登录，并按自己的财务数据权限显示。';
    $('#share-send').textContent = '复制链接后到企微发送'; copyButton.classList.add('hidden'); actions.classList.add('single-action');
    modal.classList.remove('hidden'); $('#share-send').focus();
  };
  const close = () => { modal.classList.add('hidden'); $('#share-entry').focus(); };
  $('#share-entry').addEventListener('click', open); $('#share-close').addEventListener('click', close); $('#share-copy').addEventListener('click', copyShareLink);
  $('#share-send').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; button.textContent = '正在复制…'; try { await sendShareCard(); } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; button.textContent = '复制链接后到企微发送'; } });
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
}
const canViewCurrentReportDetail = () => state.bootstrap?.reportDetailAccess?.[state.reportType] === true;
const companyNameByKey = key => key === '*' ? '全部公司' : state.bootstrap?.companies.find(item => item.key === key)?.name || key;
const availablePeriods = () => state.bootstrap?.availablePeriodsByCompany?.[state.company] || [];
const visibleReportTypes = () => (state.bootstrap?.modules || []).filter(item => reportNames[item.key] || state.bootstrap?.reportTypes?.some(type => type.key === item.key));

function renderNav() {
  const modules = state.bootstrap?.modules || [];
  const reportKeys = new Set((state.bootstrap?.reportTypes || []).map(item => item.key));
  const consolidatedEntitiesByReport = state.bootstrap?.consolidatedEntitiesByReport || {};
  const nav = $('#nav-container'); if (!nav) return;
  const canReorder = state.bootstrap?.canManagePermissions === true;
  let reportSectionAdded = false;
  nav.innerHTML = modules.map(module => {
    if (module.key === 'home') return `<button class="nav-item nav-home" data-page="home"><span class="nav-home-icon" aria-hidden="true">⌂</span><span class="nav-item-label">首页</span></button>`;
    const section = (module.key === financialBriefModuleKey || reportKeys.has(module.key)) && !reportSectionAdded ? '<div class="nav-section">财务报表</div>' : '';
    if (section) reportSectionAdded = true;
    const handle = canReorder ? `<span class="nav-drag-handle" data-nav-drag-handle title="拖动调整模块顺序" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>` : '';
    const consolidatedEntities = consolidatedEntitiesByReport[module.key] || [];
    const isConsolidated = groupStatementReportTypes.has(module.key) && consolidatedEntities.length;
    const isRevenue = module.key === revenueStatisticsReportType;
    const isExpanded = isRevenue ? state.revenueExpanded : isConsolidated && state.consolidatedExpanded && state.consolidatedEntityReportType === module.key;
    const hasSubmenu = isConsolidated || isRevenue;
    const caret = hasSubmenu ? `<span class="nav-submenu-caret" aria-hidden="true">⌄</span>` : '';
    const submenuId = `${module.key}-child-nav`;
    const consolidatedSubmenu = consolidatedEntities.map(entity => `<button class="nav-item nav-subitem" type="button" data-entity-report-type="${escapeHtml(module.key)}" data-entity-sheet="${escapeHtml(entity.sourceSheet)}" title="${escapeHtml(entity.companyName)}"><span class="nav-subitem-mark" aria-hidden="true"></span><span class="nav-item-label">${escapeHtml(entity.companyName)}</span></button>`).join('');
    const revenueSubmenu = revenueDimensions.map(dimension => `<button class="nav-item nav-subitem" type="button" data-revenue-dimension="${dimension.key}"><span class="nav-subitem-mark" aria-hidden="true"></span><span class="nav-item-label">${dimension.name}</span></button>`).join('');
    const submenu = hasSubmenu ? `<div class="nav-submenu ${isExpanded ? 'expanded' : ''}" data-nav-submenu-for="${escapeHtml(module.key)}" id="${escapeHtml(submenuId)}" ${isExpanded ? '' : 'hidden'}>${isRevenue ? revenueSubmenu : consolidatedSubmenu}</div>` : '';
    return `${section}<button class="nav-item ${canReorder ? 'nav-item-sortable' : ''} ${isExpanded ? 'submenu-expanded' : ''}" type="button" data-page="${escapeHtml(module.key)}" data-module-key="${escapeHtml(module.key)}" title="${escapeHtml(module.name)}" ${hasSubmenu ? `aria-expanded="${isExpanded}" aria-controls="${escapeHtml(submenuId)}"` : ''}>${handle}<span class="nav-item-label">${escapeHtml(module.name)}</span>${caret}</button>${submenu}`;
  }).join('');
  nav.querySelectorAll('.nav-item[data-page]').forEach(item => item.onclick = () => item.dataset.page === revenueStatisticsReportType ? openRevenueParent() : groupStatementReportTypes.has(item.dataset.page) ? openConsolidatedParent(item.dataset.page) : navigateToPage(item.dataset.page));
  nav.querySelectorAll('.nav-subitem[data-entity-sheet]').forEach(item => item.onclick = () => openConsolidatedEntity(item.dataset.entityReportType, item.dataset.entitySheet));
  nav.querySelectorAll('.nav-subitem[data-revenue-dimension]').forEach(item => item.onclick = () => openRevenueDimension(item.dataset.revenueDimension));
  if (canReorder) bindSidebarModuleOrder(nav);
  setActiveNav();
  revealActiveNav(nav);
}
function bindSidebarModuleOrder(nav) {
  let active = null; let handle = null; let moved = false;
  const submenuFor = item => item?.nextElementSibling?.matches?.(`[data-nav-submenu-for="${item.dataset.moduleKey}"]`) ? item.nextElementSibling : null;
  const fullOrderFor = visibleOrder => {
    const visible = new Set(visibleOrder); let cursor = 0;
    return (state.bootstrap?.moduleOrder || []).map(item => visible.has(item.key) ? visibleOrder[cursor++] : item.key);
  };
  const finish = event => {
    if (!active) return;
    handle?.releasePointerCapture?.(event.pointerId); active.classList.remove('nav-dragging'); nav.classList.remove('nav-order-dragging');
    const visibleOrder = [...nav.querySelectorAll('.nav-item[data-module-key]')].map(item => item.dataset.moduleKey); active = null; handle = null;
    if (!moved) return;
    const order = fullOrderFor(visibleOrder);
    api('/api/admin/module-order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) })
      .then(result => { state.bootstrap.moduleOrder = result.moduleOrder; showNotice('左侧模块顺序已保存，对所有员工生效'); refresh(); })
      .catch(error => { showNotice(error.message, true); refresh(); });
  };
  nav.querySelectorAll('[data-nav-drag-handle]').forEach(grip => {
    grip.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopPropagation(); active = grip.closest('.nav-item'); handle = grip; moved = false;
      grip.setPointerCapture?.(event.pointerId); active.classList.add('nav-dragging'); nav.classList.add('nav-order-dragging');
    });
    grip.addEventListener('pointermove', event => {
      if (!active) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.nav-item[data-module-key]');
      if (!target || target === active || target.parentElement !== nav) return;
      const rect = target.getBoundingClientRect(); const horizontal = getComputedStyle(nav).flexDirection === 'row';
      const beforeTarget = horizontal ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
      const activeSubmenu = submenuFor(active); const reference = beforeTarget ? target : (submenuFor(target)?.nextSibling || target.nextSibling);
      nav.insertBefore(active, reference); if (activeSubmenu) nav.insertBefore(activeSubmenu, active.nextSibling); moved = true;
    });
    grip.addEventListener('pointerup', finish); grip.addEventListener('pointercancel', finish);
    grip.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  });
}

function animateAnalysisReflow(container, mutate) {
  const blocks = [...container.querySelectorAll(':scope > [data-analysis-block]')];
  const firstRects = new Map(blocks.map(block => [block, block.getBoundingClientRect()]));
  mutate();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  blocks.forEach(block => {
    const first = firstRects.get(block); const last = block.getBoundingClientRect(); const dx = first.left - last.left; const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const animation = block.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: `translate(${-dx * 0.025}px, ${-dy * 0.025}px)`, offset: 0.82 },
      { transform: 'translate(0, 0)' }
    ], { duration: 260, easing: 'cubic-bezier(.2,.82,.24,1)' });
    animation.id = 'analysis-reflow';
  });
}

const analysisCollapseStorageKey = pageKey => `wecom-finance-analysis-collapsed:${state.employeeKey}:${pageKey}`;
const readCollapsedAnalysisBlocks = pageKey => {
  try { const saved = JSON.parse(window.localStorage?.getItem(analysisCollapseStorageKey(pageKey)) || '[]'); return new Set(Array.isArray(saved) ? saved : []); }
  catch { return new Set(); }
};
const saveCollapsedAnalysisBlocks = (pageKey, collapsed) => {
  try { window.localStorage?.setItem(analysisCollapseStorageKey(pageKey), JSON.stringify([...collapsed])); } catch { /* 无持久存储时仍保留当前页面交互。 */ }
};

function applyAnalysisBlockLayout(container, pageKey) {
  if (!container) return;
  const blockAccess = state.bootstrap?.analysisBlockAccess?.[pageKey] || {};
  [...container.querySelectorAll(':scope > [data-analysis-block]')].forEach(block => {
    if (blockAccess[block.dataset.analysisBlock] === false) block.remove();
  });
  const blocks = [...container.querySelectorAll(':scope > [data-analysis-block]')];
  const byKey = new Map(blocks.map(block => [block.dataset.analysisBlock, block]));
  const saved = state.bootstrap?.analysisBlockOrder?.[pageKey] || [];
  [...new Set([...saved, ...blocks.map(block => block.dataset.analysisBlock)])].forEach(key => { const block = byKey.get(key); if (block && block.parentElement === container) container.appendChild(block); });
  const collapsedBlocks = readCollapsedAnalysisBlocks(pageKey);
  const canReorder = state.bootstrap?.canManagePermissions === true;
  const fullOrderFor = visibleOrder => {
    const complete = state.bootstrap?.analysisBlockOrder?.[pageKey] || [];
    const visible = new Set(visibleOrder); let cursor = 0;
    return complete.map(key => visible.has(key) ? visibleOrder[cursor++] : key);
  };
  if (canReorder) container.classList.add('analysis-layout-editable');
  blocks.forEach(block => {
    block.classList.add('analysis-layout-block');
    const blockKey = block.dataset.analysisBlock;
    const isStatic = blockKey?.endsWith('_source');
    if (isStatic) block.classList.add('analysis-layout-static');
    const label = block.querySelector('h2,h3,.metric-label,strong')?.textContent?.trim() || '分析板块';
    const body = document.createElement('div'); body.className = 'analysis-block-body'; body.id = `${pageKey}-${blockKey}-body`;
    while (block.firstChild) body.appendChild(block.firstChild);
    block.appendChild(body);
    const summary = document.createElement('div'); summary.className = 'analysis-collapse-summary'; summary.innerHTML = `<strong>${escapeHtml(label)}</strong><span>已折叠</span>`; block.appendChild(summary);
    const collapse = document.createElement('button'); collapse.type = 'button'; collapse.className = 'analysis-collapse-toggle'; collapse.setAttribute('aria-controls', body.id); collapse.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 12.5 10 7.5l5 5"/></svg>';
    const renderCollapseState = () => {
      const isCollapsed = collapsedBlocks.has(blockKey);
      block.classList.toggle('analysis-collapsed', isCollapsed); body.hidden = isCollapsed;
      collapse.classList.toggle('is-collapsed', isCollapsed); collapse.setAttribute('aria-expanded', String(!isCollapsed));
      collapse.setAttribute('aria-label', `${isCollapsed ? '展开' : '折叠'}${label}`); collapse.title = `${isCollapsed ? '展开' : '折叠'}${label}`;
    };
    collapse.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (collapsedBlocks.has(blockKey)) collapsedBlocks.delete(blockKey); else collapsedBlocks.add(blockKey); saveCollapsedAnalysisBlocks(pageKey, collapsedBlocks); renderCollapseState(); });
    block.appendChild(collapse); renderCollapseState();
    if (!canReorder || isStatic) return;
    const overlay = document.createElement('div'); overlay.className = 'analysis-drag-overlay';
    const handle = document.createElement('button');
    handle.type = 'button'; handle.className = 'analysis-drag-handle'; handle.setAttribute('aria-label', `拖动${label}`); handle.title = '按住拖动调整位置'; handle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7" cy="5" r="1.25"/><circle cx="13" cy="5" r="1.25"/><circle cx="7" cy="10" r="1.25"/><circle cx="13" cy="10" r="1.25"/><circle cx="7" cy="15" r="1.25"/><circle cx="13" cy="15" r="1.25"/></svg>';
    overlay.appendChild(handle); block.appendChild(overlay);
    let active = null; let moved = false; let moveFrame = 0; let latestPointer = null;
    const finish = event => {
      if (!active) return;
      if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
      handle.releasePointerCapture?.(event.pointerId); active.classList.remove('analysis-block-dragging'); container.classList.remove('dragging');
      if (moved && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) block.animate([{ transform: 'scale(.992)' }, { transform: 'scale(1.006)', offset: .55 }, { transform: 'scale(1)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.25,1)' });
      const visibleOrder = [...container.querySelectorAll(':scope > [data-analysis-block]')].map(item => item.dataset.analysisBlock); const order = fullOrderFor(visibleOrder); active = null; latestPointer = null;
      if (!moved) return;
      api('/api/admin/analysis-block-order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageKey, order }) })
        .then(result => { state.bootstrap.analysisBlockOrder[pageKey] = result.order; showNotice('分析板块顺序已保存'); })
        .catch(error => { showNotice(error.message, true); refresh(); });
    };
    handle.addEventListener('pointerdown', event => { event.preventDefault(); active = block; moved = false; handle.setPointerCapture?.(event.pointerId); block.classList.add('analysis-block-dragging'); container.classList.add('dragging'); });
    handle.addEventListener('pointermove', event => {
      if (!active) return;
      event.preventDefault(); latestPointer = { x: event.clientX, y: event.clientY };
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0; if (!active || !latestPointer) return;
        const { x, y } = latestPointer; const target = document.elementFromPoint(x, y)?.closest?.('[data-analysis-block]');
        if (!target || target === active || target.parentElement !== container) return;
        const rect = target.getBoundingClientRect(); const activeRect = active.getBoundingClientRect(); const sameRow = Math.abs(rect.top - activeRect.top) < Math.min(rect.height, activeRect.height) / 2; const after = sameRow ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2;
        const placement = after ? target.nextElementSibling : target; if (placement === active || (!after && active.nextElementSibling === target)) return;
        animateAnalysisReflow(container, () => container.insertBefore(active, placement)); moved = true;
      });
    });
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });
}

async function loadBootstrap() {
  let bootstrap = assertCompatibleAppVersion(await api(`/api/bootstrap?company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}`));
  const nextCompany = bootstrap.companies.some(item => item.key === state.company) ? state.company : bootstrap.companies[0]?.key;
  const companyPeriods = bootstrap.availablePeriodsByCompany?.[nextCompany] || [];
  const nextPeriod = state.periodExplicit && companyPeriods.includes(state.period) ? state.period : (companyPeriods[0] || state.period);
  if (nextCompany && (nextCompany !== state.company || nextPeriod !== state.period)) {
    state.company = nextCompany; state.period = nextPeriod;
    bootstrap = assertCompatibleAppVersion(await api(`/api/bootstrap?company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}`));
  }
  state.periodExplicit = true;
  state.bootstrap = bootstrap;
  state.employeeKey = bootstrap.employee.key || state.employeeKey;
  const consolidatedScope = `${state.employeeKey}:${state.company}:${state.period}`;
  const availableEntitySheets = new Set((bootstrap.consolidatedEntitiesByReport?.[state.consolidatedEntityReportType] || []).map(entity => entity.sourceSheet));
  if (state.consolidatedScope !== consolidatedScope || (state.consolidatedEntitySheet && !availableEntitySheets.has(state.consolidatedEntitySheet))) {
    state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; state.consolidatedExpanded = false;
  }
  state.consolidatedScope = consolidatedScope;
  const employeeSelect = $('#employee-select');
  const employeeDisplay = $('#employee-display');
  employeeSelect.innerHTML = state.bootstrap.employees.map(employee => `<option value="${escapeHtml(employee.key)}">${escapeHtml(employee.name)} · ${escapeHtml(employee.department)}</option>`).join('');
  employeeSelect.value = state.employeeKey;
  employeeSelect.classList.toggle('hidden', bootstrap.authMode !== 'demo');
  employeeDisplay.classList.toggle('hidden', bootstrap.authMode === 'demo');
  employeeDisplay.textContent = `${bootstrap.employee.name} · ${bootstrap.employee.department}`;
  employeeSelect.onchange = bootstrap.authMode !== 'demo' ? null : async event => { state.employeeKey = event.target.value; state.periodExplicit = false; state.version = null; await refresh(); };
  renderNav();
  const visible = new Set((state.bootstrap.modules || []).map(item => item.key));
  if (state.page !== 'journal_detail' && !visible.has(state.page)) state.page = 'home';
}

function filterHtml() {
  return `<div class="filter"><label><span>公司</span><span class="filter-text">${escapeHtml(currentCompanyName())}</span></label><label><span>期间</span><span class="filter-text">${escapeHtml(state.period)}</span></label>${reportPageTypes.includes(state.page) ? `<label><span>版本</span><select id="version-select"><option>加载中…</option></select></label>` : ''}</div>`;
}

function renderMissingData(container, title, requiredSource = '对应报表') {
  const canUpload = Boolean(state.bootstrap?.canUploadReports);
  const periodLabel = state.period;
  const emptyMessage = '当前公司及期间暂无已上传数据。';
  container.innerHTML = `<div class="page-title"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(currentCompanyName())} · ${escapeHtml(periodLabel)}</p></div>${filterHtml()}</div><section class="missing-data-state" aria-live="polite"><div class="missing-data-icon" aria-hidden="true">—</div><h2>暂无数据</h2><p>${escapeHtml(emptyMessage)}</p><small>请上传并发布${escapeHtml(requiredSource)}后查看；系统不会复用其他公司的模板或数据。</small>${canUpload ? '<button class="button primary missing-data-upload" type="button">前往上传报表</button>' : ''}</section>`;
  bindCommonFilters();
  container.querySelector('.missing-data-upload')?.addEventListener('click', () => navigateToPage('uploads'));
}

function bindHomeCompanyReorder(container) {
  if (!container || state.bootstrap?.canReorderCompanies !== true) return;
  container.classList.add('company-reorder-enabled');
  let pressed = null; let active = null; let timer = 0; let pointerId = null; let startX = 0; let startY = 0; let ghost = null; let moved = false; let suppressCompanyKey = '';
  const clearTimer = () => { if (timer) window.clearTimeout(timer); timer = 0; };
  const activate = () => {
    if (!pressed) return;
    active = pressed; moved = false; const rect = active.getBoundingClientRect();
    ghost = active.cloneNode(true); ghost.classList.remove('selected'); ghost.classList.add('home-company-drag-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`; ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`; document.body.appendChild(ghost);
    active.classList.add('home-company-option-dragging'); container.classList.add('company-reorder-active'); active.setPointerCapture?.(pointerId); if (navigator.vibrate) navigator.vibrate(18);
  };
  const cancelPending = () => { clearTimer(); pressed = null; pointerId = null; };
  const finish = (event, cancelled = false) => {
    clearTimer(); if (!pressed) return;
    if (!active) { cancelPending(); return; }
    active.releasePointerCapture?.(pointerId); const dropped = active; const order = [...container.querySelectorAll('[data-home-company]')].map(item => item.dataset.homeCompany);
    suppressCompanyKey = dropped.dataset.homeCompany; window.setTimeout(() => { suppressCompanyKey = ''; }, 0);
    ghost?.remove(); ghost = null; dropped.classList.remove('home-company-option-dragging'); dropped.classList.add('home-company-option-settling'); window.setTimeout(() => dropped.classList.remove('home-company-option-settling'), 300); container.classList.remove('company-reorder-active');
    active = null; pressed = null; pointerId = null;
    if (cancelled || !moved) return;
    const byKey = new Map(state.bootstrap.companies.map(company => [company.key, company])); state.bootstrap.companies = order.map(key => byKey.get(key)).filter(Boolean);
    api('/api/admin/company-order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) }).then(() => showNotice('公司顺序已保存并对所有员工生效')).catch(error => { showNotice(error.message, true); refresh(); });
  };
  container.addEventListener('pointerdown', event => {
    const card = event.target.closest('[data-home-company]'); if (!card || event.button !== 0) return;
    clearTimer(); pressed = card; pointerId = event.pointerId; startX = event.clientX; startY = event.clientY; timer = window.setTimeout(activate, 460);
  });
  container.addEventListener('pointermove', event => {
    if (!pressed || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX; const dy = event.clientY - startY;
    if (!active) { if (Math.hypot(dx, dy) > 8) cancelPending(); return; }
    event.preventDefault(); if (ghost) ghost.style.transform = `translate(${dx}px,${dy}px) scale(1.035) rotate(-.4deg)`;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-home-company]'); if (!target || target === active || target.parentElement !== container) return;
    const rect = target.getBoundingClientRect(); const activeRect = active.getBoundingClientRect(); const sameRow = Math.abs(rect.top - activeRect.top) < Math.min(rect.height, activeRect.height) / 2; const after = sameRow ? event.clientX > rect.left + rect.width / 2 : event.clientY > rect.top + rect.height / 2;
    const placement = after ? target.nextElementSibling : target; if (placement === active || (!after && active.nextElementSibling === target)) return;
    animateAnalysisReflow(container, () => container.insertBefore(active, placement)); moved = true;
  });
  container.addEventListener('pointerup', event => finish(event)); container.addEventListener('pointercancel', event => finish(event, true));
  container.addEventListener('contextmenu', event => { if (event.target.closest('[data-home-company]')) event.preventDefault(); });
  container.addEventListener('click', event => { const card = event.target.closest('[data-home-company]'); if (card && card.dataset.homeCompany === suppressCompanyKey) { event.preventDefault(); event.stopPropagation(); } }, true);
}

function renderHome() {
  const page = $('#home-page');
  const canReorderCompanies = state.bootstrap?.canReorderCompanies === true;
  const hasCompanies = state.bootstrap.companies.length > 0;
  const periods = availablePeriods();
  const periodGroups = Object.entries(periods.reduce((groups, period) => {
    const [year, month] = String(period).split('-');
    (groups[year] ||= []).push({ value: period, month });
    return groups;
  }, {}));
  const companies = state.bootstrap.companies.map((company, index) => {
    const count = state.bootstrap.availablePeriodsByCompany?.[company.key]?.length || 0;
    const selected = company.key === state.company;
    return `<button type="button" class="home-company-option ${selected ? 'selected' : ''}" data-home-company="${escapeHtml(company.key)}" role="radio" aria-checked="${selected}"${canReorderCompanies ? ' aria-roledescription="可长按拖动排序的公司卡片"' : ''}><span class="home-company-mark tone-${index % 3}">${escapeHtml(company.name.slice(0, 2))}</span><span class="home-company-copy"><strong>${escapeHtml(company.name)}</strong><small>${count ? `${count} 个可用期间` : '暂无已发布数据'}</small></span><span class="home-choice-check" aria-hidden="true">✓</span></button>`;
  }).join('') || '<div class="home-period-empty"><span>—</span><strong>暂无可查看数据</strong><small>请联系财务管理员配置数据范围</small></div>';
  const periodOptions = periodGroups.length ? periodGroups.map(([year, items]) => `<div class="home-period-year"><strong>${escapeHtml(year)}</strong><div class="home-period-options">${items.map(item => `<button type="button" class="home-period-option ${item.value === state.period ? 'selected' : ''}" data-home-period="${escapeHtml(item.value)}" aria-pressed="${item.value === state.period}"><span>${escapeHtml(item.month)}月</span><small>${escapeHtml(item.value)}</small></button>`).join('')}</div></div>`).join('') : `<div class="home-period-empty"><span>—</span><strong>${hasCompanies ? '暂无可用期间' : '暂无可查看数据'}</strong><small>${hasCompanies ? '请先上传并发布当前公司的财务报表' : '数据范围配置完成后，可用期间将在此显示'}</small></div>`;
  const reportKeys = new Set((state.bootstrap.reportTypes || []).map(item => item.key));
  const nextModule = state.bootstrap.modules.find(item => item.key === financialBriefModuleKey || reportKeys.has(item.key));
  page.innerHTML = `<section class="home-stage"><div class="home-ambient home-ambient-one"></div><div class="home-ambient home-ambient-two"></div><header class="home-heading"><span class="home-eyebrow">FINANCE WORKSPACE</span><h1>选择本次查看范围</h1><p>先确定公司与会计期间，进入后所有报表和分析将保持同一数据口径。</p></header><div class="home-scope-card"><section class="home-scope-section"><div class="home-step-title"><span>01</span><div><strong>选择公司</strong><small>${canReorderCompanies ? '按当前员工的数据权限显示 · 长按公司卡片可调整全局顺序' : '按当前员工的数据权限显示'}</small></div></div><div class="home-company-options" role="radiogroup" aria-label="选择公司">${companies}</div></section><div class="home-scope-divider" aria-hidden="true"><span></span></div><section class="home-scope-section"><div class="home-step-title"><span>02</span><div><strong>选择期间</strong><small>仅列出已有已发布数据的月份</small></div></div><div class="home-period-list">${periodOptions}</div></section><footer class="home-confirm-bar"><div class="home-current-scope"><span>当前查看范围</span><strong>${escapeHtml(hasCompanies ? currentCompanyName() : '未选择公司')}</strong><i></i><strong>${periods.length ? escapeHtml(state.period) : '未选择期间'}</strong></div><button type="button" class="home-enter-button" ${!nextModule || !periods.length ? 'disabled' : ''}><span>开始浏览报表</span><b aria-hidden="true">→</b></button></footer></div></section>`;
  page.querySelectorAll('[data-home-company]').forEach(button => button.onclick = async () => {
    state.company = button.dataset.homeCompany;
    state.periodExplicit = false;
    state.version = null;
    await refresh();
  });
  bindHomeCompanyReorder(page.querySelector('.home-company-options'));
  page.querySelectorAll('[data-home-period]').forEach(button => button.onclick = async () => { state.period = button.dataset.homePeriod; state.periodExplicit = true; state.version = null; await refresh(); });
  page.querySelector('.home-enter-button')?.addEventListener('click', () => { if (nextModule) navigateToPage(nextModule.key); });
}

function bindCommonFilters() { $('#company-select')?.addEventListener('change', event => { state.company = event.target.value; state.version = null; state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; refresh(); }); $('#period-select')?.addEventListener('change', event => { state.period = event.target.value; state.version = null; state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; refresh(); }); $('#version-select')?.addEventListener('change', async event => { state.version = event.target.value === 'current' ? null : event.target.value; state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; await refreshReport(); applyReportWatermark(); }); }

const directionFor = row => { const debit = Number(row.debit || 0); const credit = Number(row.credit || 0); if (debit && credit) return '借/贷'; if (debit) return '借'; if (credit) return '贷'; return ''; };
const amountFor = row => { const debit = Number(row.debit || 0); const credit = Number(row.credit || 0); if (debit && credit) return `${statementAmount(debit)} / ${statementAmount(credit)}`; if (debit) return statementAmount(debit); if (credit) return statementAmount(credit); return statementAmount(row.balance || 0); };
const detailAmount = amountFor;
function detailTableHtml(rows, showDirection = true) { return rows.length ? `<div class="table-wrap"><table class="data-table journal-detail-table${showDirection ? '' : ' no-direction'}"><colgroup><col class="journal-voucher"><col class="journal-account"><col class="journal-summary">${showDirection ? '<col class="journal-direction">' : ''}<col class="journal-amount"></colgroup><thead><tr><th>凭证号</th><th>科目名称</th><th>摘要</th>${showDirection ? '<th>借贷方向</th>' : ''}<th>金额</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.voucher)}</td><td>${escapeHtml(row.account || row.accountCode)}</td><td class="summary-cell">${escapeHtml(row.summary)}</td>${showDirection ? `<td class="journal-direction direction-cell">${escapeHtml(directionFor(row))}</td>` : ''}<td class="num amount-cell">${escapeHtml(amountFor(row))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">当前员工没有明细权限，或该项目没有明细数据。</div>'; }
function rawMatchTableHtml(rows) { return rows?.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>来源行</th><th>原始资料匹配内容</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.row)}</td><td>${escapeHtml((row.cells || []).filter(value => value !== null && value !== '').join('　'))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">该原始项目暂无已关联明细。</div>'; }

async function openRawDetail(search, detailPeriod = '', accountCodes = []) {
  if (!search) return;
  state.detailSearch = search; state.detailPeriod = detailPeriod || state.period; state.detailAccountCodes = [...new Set(accountCodes.filter(Boolean))]; state.detailReportType = state.reportType; state.page = 'journal_detail'; state.version = null; await refresh();
}

function journalRowsTableHtml(rows, showDirection = true) { return rows?.length ? `<div class="table-wrap"><table class="data-table journal-detail-table${showDirection ? '' : ' no-direction'}"><colgroup><col class="journal-voucher"><col class="journal-account"><col class="journal-summary">${showDirection ? '<col class="journal-direction">' : ''}<col class="journal-amount"></colgroup><thead><tr><th>凭证号</th><th>科目名称</th><th>摘要</th>${showDirection ? '<th>借贷方向</th>' : ''}<th>金额</th></tr></thead><tbody>${rows.map(row => { const c = row.cells || []; const debit = Number(c[5] || 0); const credit = Number(c[6] || 0); const direction = debit && credit ? '借/贷' : debit ? '借' : credit ? '贷' : ''; const amount = debit && credit ? `${statementAmount(debit)} / ${statementAmount(credit)}` : debit ? statementAmount(debit) : credit ? statementAmount(credit) : '-'; return `<tr><td>${escapeHtml(c[1])}</td><td>${escapeHtml(c[4])}</td><td class="summary-cell">${escapeHtml(c[2])}</td>${showDirection ? `<td class="journal-direction direction-cell">${escapeHtml(direction)}</td>` : ''}<td class="num amount-cell">${escapeHtml(amount)}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">暂无匹配的序时账明细。</div>'; }

function cashFlowWorkpaperTableHtml(rows) { return rows?.length ? `<div class="table-wrap"><table class="data-table cash-workpaper-detail-table"><thead><tr><th>日期</th><th>凭证号</th><th>摘要</th><th>科目名称</th><th>现金流入</th><th>现金流出</th><th>现金流量表项目</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.voucher)}</td><td class="summary-cell">${escapeHtml(row.summary)}</td><td>${escapeHtml(row.account)}</td><td class="num">${statementAmount(row.debit)}</td><td class="num">${statementAmount(row.credit)}</td><td>${escapeHtml(row.project)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">该项目在当前期间的现金流量表底稿中暂无匹配明细。</div>'; }

async function renderJournalDetail() {
  const page = $('#detail-page'); const reportType = state.detailReportType || 'income_statement'; const search = state.detailSearch || ''; const detailPeriod = state.detailPeriod || state.period;
  try {
    const accountCodes = state.detailAccountCodes || []; const accountCodeQuery = accountCodes.length ? `&accountCodes=${encodeURIComponent(accountCodes.join(','))}` : '';
    const query = `company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(detailPeriod)}&search=${encodeURIComponent(search)}${accountCodeQuery}`; const detail = await api(`/api/reports/${reportType}/detail?${query}`);
    const showDirection = detail.showDirection !== false;
    const entryHint = detail.showFullEntry === false ? ' · 仅展示所点击科目的分录行' : ' · 已展开命中凭证的完整分录';
    const isCashWorkpaper = detail.detailKind === 'cash_flow_workpaper';
    const title = isCashWorkpaper ? '现金流量表底稿明细' : '序时账明细清单';
    const sourceHint = isCashWorkpaper ? `底稿工作表：${escapeHtml(detail.detailSourceSheet || '现金流量表底稿')} · 按“现金流量表项目”字段匹配` : `明细来源优先使用序时账；当前员工仅能看到授权范围内的数据${entryHint}${showDirection ? '' : ' · 借贷方向列已按角色权限隐藏'}`;
    const content = isCashWorkpaper ? cashFlowWorkpaperTableHtml(detail.workpaperRows || []) : (detail.rows?.length ? detailTableHtml(detail.rows, showDirection) : journalRowsTableHtml(detail.rawRows || [], showDirection));
    page.innerHTML = `<div class="page-title"><div><h1>${title}</h1><p>来源项目：${escapeHtml(search)}　·　${escapeHtml(currentCompanyName())} · ${escapeHtml(detailPeriod)}</p></div><button class="button" id="back-report">返回报表</button></div><section class="panel"><div class="toolbar"><div><h2>对应明细</h2><div class="panel-sub">${sourceHint}</div></div></div>${content}</section>`;
    $('#back-report').onclick = () => { state.page = reportType; state.reportType = reportType; state.detailSearch = ''; state.detailPeriod = ''; state.detailAccountCodes = []; refresh(); };
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br><button class="button" id="back-report">返回报表</button></div>`; $('#back-report').onclick = () => { state.page = reportType; state.reportType = reportType; state.detailPeriod = ''; state.detailAccountCodes = []; refresh(); }; }
}

function renderRawReport(data) {
  if (data.meta?.noData) { renderMissingData($('#report-page'), reportNames[state.reportType] || state.reportType, reportNames[state.reportType] || '对应报表'); return; }
  if (state.reportType === 'balance_sheet') return renderBalanceSheet(data);
  if (state.reportType === 'income_statement') return renderIncomeStatement(data);
  if (state.reportType === 'consolidated_income_statement') return renderConsolidatedIncomeStatement(data);
  if (state.reportType === revenueProfitReportType) return renderRevenueProfitConsolidatedStatement(data);
  if (state.reportType === 'cash_flow') return renderCashFlowStatement(data);
  if (state.reportType === 'trial_balance') return renderTrialBalance(data);
  if (state.reportType === 'journal') return renderJournalStatement(data);
  const raw = data.raw || {}; const rows = trimTrailingEmptyRows(raw.rows || []); const maxCol = Math.max(raw.maxCol || 0, ...rows.map(item => (item.cells || []).length), 1);
  // 原始资料中占比列仅用于模板计算，本看板不展示；保留金额、项目和左右两侧原始区域。
  const headerRow = rows.find(item => (item.cells || []).some(value => String(value ?? '').includes('项目')));
  const hiddenColumns = new Set(); rows.forEach(item => (item.cells || []).forEach((value, index) => { if (String(value ?? '').includes('占比')) hiddenColumns.add(index); }));
  const meaningfulColumns = Array.from({ length: maxCol }, (_, index) => index).filter(index => rows.some(item => String(item.cells?.[index] ?? '').trim() !== ''));
  const visibleColumns = meaningfulColumns.filter(index => !hiddenColumns.has(index));
  const columnLabel = index => String(headerRow?.cells?.[index] ?? '').trim() || `列 ${index + 1}`;
  const canViewDetail = canViewCurrentReportDetail();
  const rowHtml = rows.map(item => { const cells = item.cells || []; const firstText = cells.find(value => typeof value === 'string' && value.trim() && !/^\d{4}-\d{2}-\d{2}/.test(value.trim())); const clickable = canViewDetail && Boolean(firstText); let previousString = null; const cellHtml = visibleColumns.map(index => { const value = cells[index] ?? ''; const duplicateMergedText = typeof value === 'string' && value.trim() && value === previousString; if (typeof value === 'string' && value.trim()) previousString = value; const rendered = typeof value === 'number' && Number.isFinite(value) && clickable ? `<button class="raw-number" data-search="${escapeHtml(firstText)}" title="点击查看 ${escapeHtml(firstText)} 明细">${escapeHtml(value)}</button>` : escapeHtml(value); return `<td>${duplicateMergedText ? '' : rendered}</td>`; }).join(''); const headerClass = item === headerRow ? 'raw-source-header' : ''; return `<tr class="raw-row ${headerClass}" data-search="${escapeHtml(firstText || '')}" title="${clickable ? '金额可点击查看关联明细' : ''}">${cellHtml}</tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="page-title"><div><h1>${escapeHtml(reportNames[state.reportType] || state.reportType)}</h1><p>${escapeHtml(data.company || currentCompanyName())} · ${state.period}</p></div>${filterHtml()}</div><section class="panel report-standard"><div class="toolbar"><div><h2>原始资料报表</h2><div class="panel-sub">源文件：${escapeHtml(data.meta?.fileName || '—')}　·　工作表：${escapeHtml(raw.sourceSheet || '—')}　·　${data.meta?.demo ? '演示模板参考，等待用户上传' : `上传批次：${escapeHtml(data.meta.uploadKey)} · ${escapeHtml(data.meta.status)}`}</div></div><div class="toolbar-actions">${state.bootstrap.canUploadReports ? '<button class="button primary" id="go-upload">上传新报表</button>' : ''}</div></div><div class="table-wrap"><table class="data-table raw-table"><tbody>${rowHtml || `<tr><td colspan="${visibleColumns.length}" class="empty">当前期间暂无已发布原始资料，请先上传报表。</td></tr>`}</tbody></table></div>${canViewDetail ? '<div class="standard-hint">保留原始报表行列和表头；金额单元格可点击跳转到对应明细。</div>' : ''}</section><section id="raw-detail-panel" class="panel hidden" style="margin-top:16px"><div class="toolbar"><div><h2 id="raw-detail-heading">关联明细</h2><div class="panel-sub">来源：${escapeHtml(data.meta?.fileName || '—')}</div></div></div><div id="raw-detail-content"></div></section>`;
  bindCommonFilters(); if ($('#version-select')) $('#version-select').innerHTML = '<option value="current">当前发布</option>'; document.querySelectorAll('.raw-number').forEach(button => button.onclick = event => { event.stopPropagation(); openRawDetail(button.dataset.search, button.dataset.detailPeriod); });
}

const financialBriefAmountText = amount => amount === null || amount === undefined ? '—' : Number(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const financialBriefMetricRows = brief => {
  const m = brief.metrics || {}; const value = financialBriefAmountText;
  return [
    { key: 'expectedRevenue', label: '预计营收', amount: value(m.expectedRevenue), plainGap: ' ' },
    { key: 'accountBalance', label: '账户余额', amount: `${value(m.accountBalance)}元` },
    { key: 'operatingRevenue', label: '营业收入（销售额）', amount: value(m.operatingRevenue) },
    { key: 'operatingCost', label: '营业成本（项目成本）', amount: value(m.operatingCost) },
    { key: 'sellingExpense', label: '销售费用', amount: value(m.sellingExpense), description: `（包括销售人员工资社保公积金，广宣费，办公费，业务招待费等），其中广宣费 ${value(m.advertisingExpense)}；`, plainDescription: `（包括销售人员工资社保公积金，广宣费，办公费，业务招待费等），其中广宣费${value(m.advertisingExpense)}；` },
    { key: 'managementExpense', label: '管理费用', amount: value(m.managementExpense), description: '（包括租金管理费，后勤人员工资社保公积金，办公费、固定资产的折旧等）' },
    { key: 'financeExpense', label: '财务费用', amount: value(m.financeExpense), description: '（包括银行及二维码收款的手续费、预付款承担的税点、汇率差等）' },
    { key: 'netProfit', label: '净利润', amount: value(m.netProfit), description: '（考虑上面所有收支最终得出公司利润）' },
    { key: 'comprehensiveRevenueProfit', label: '营收综合利润', amount: value(m.comprehensiveRevenueProfit), result: true }
  ];
};
const financialBriefPlainText = brief => {
  const [year, month] = String(brief.period || '').split('-'); const notes = brief.notes || [];
  return [
    `${year}年${Number(month)}月收支部分明细`,
    brief.scopeLabel || '',
    ...financialBriefMetricRows(brief).flatMap(row => [
      `${row.label}${row.plainGap || ''}${row.amount}${row.plainDescription ?? row.description ?? ''}`,
      ...notes.filter(note => note.metricKey === row.key).map(note => `  备注：${String(note.text || '').replace(/\s+/g, ' ').trim()}`)
    ])
  ].join('\n');
};
const financialBriefRowsHtml = brief => financialBriefMetricRows(brief).map(row => {
  const notes = (brief.notes || []).filter(note => note.metricKey === row.key);
  const noteHtml = notes.map(note => `<article class="financial-brief-note" data-note-key="${escapeHtml(note.noteKey)}"><span>备注</span><p>${escapeHtml(note.text)}</p><small>${escapeHtml(note.authorName || '')}${note.updatedAt !== note.createdAt ? ' · 已修改' : ''}</small>${brief.canManageNotes ? `<div><button type="button" class="financial-brief-note-edit" data-note-key="${escapeHtml(note.noteKey)}">编辑</button><button type="button" class="financial-brief-note-delete" data-note-key="${escapeHtml(note.noteKey)}">删除</button></div>` : ''}</article>`).join('');
  return `<section class="financial-brief-item ${row.result ? 'result' : ''}" data-metric-key="${escapeHtml(row.key)}"><p class="${row.result ? 'financial-brief-result' : ''}"><strong>${escapeHtml(row.label)}</strong><b>${escapeHtml(row.amount)}</b>${row.description ? `<span>${escapeHtml(row.description)}</span>` : ''}</p>${noteHtml ? `<div class="financial-brief-notes">${noteHtml}</div>` : ''}${brief.canManageNotes ? `<button type="button" class="financial-brief-note-add" data-metric-key="${escapeHtml(row.key)}">＋ 添加二级备注</button>` : ''}</section>`;
}).join('');
const openFinancialBriefNoteEditor = (brief, button, note = null) => {
  clearFinancialBriefAutoRefresh(); document.querySelector('.financial-brief-note-editor')?.remove();
  const item = button.closest('.financial-brief-item'); const editor = document.createElement('form'); editor.className = 'financial-brief-note-editor';
  editor.innerHTML = `<input maxlength="300" required aria-label="二级项目备注" placeholder="请输入二级项目备注（最多 300 字）" value="${escapeHtml(note?.text || '')}"><button type="submit" class="button primary compact">保存</button><button type="button" class="button compact" data-cancel>取消</button>`;
  item.appendChild(editor); const input = editor.querySelector('input'); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  editor.querySelector('[data-cancel]').onclick = () => { editor.remove(); scheduleFinancialBriefAutoRefresh(); };
  editor.onsubmit = async event => { event.preventDefault(); const text = input.value.replace(/\s+/g, ' ').trim(); if (!text) return showNotice('请输入备注内容', true); const save = editor.querySelector('[type="submit"]'); save.disabled = true;
    try { await api('/api/analysis/financial-brief/notes', { method: note ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note ? { noteKey: note.noteKey, text } : { companyKey: brief.companyKey, period: brief.period, metricKey: button.dataset.metricKey, text }) }); showNotice(note ? '二级备注已更新' : '二级备注已添加'); await renderFinancialBrief({ trigger: 'notes' }); }
    catch (error) { save.disabled = false; showNotice(error.message, true); }
  };
};
const bindFinancialBriefActions = brief => {
  $('#financial-brief-refresh').onclick = () => renderFinancialBrief({ trigger: 'manual' });
  $('#financial-brief-copy-button').onclick = async event => { const button = event.currentTarget; button.disabled = true; try { await writeClipboardText(financialBriefPlainText(brief)); showNotice('简报纯文字已复制，可直接粘贴'); } catch (error) { showNotice(error.message, true); } finally { button.disabled = false; } };
  document.querySelectorAll('.financial-brief-note-add').forEach(button => button.onclick = () => openFinancialBriefNoteEditor(brief, button));
  document.querySelectorAll('.financial-brief-note-edit').forEach(button => button.onclick = () => { const note = (brief.notes || []).find(item => item.noteKey === button.dataset.noteKey); if (note) { button.dataset.metricKey = note.metricKey; openFinancialBriefNoteEditor(brief, button, note); } });
  document.querySelectorAll('.financial-brief-note-delete').forEach(button => button.onclick = async () => { const note = (brief.notes || []).find(item => item.noteKey === button.dataset.noteKey); if (!note || !window.confirm(`确定删除备注“${note.text}”吗？`)) return; button.disabled = true; try { await api('/api/analysis/financial-brief/notes', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noteKey: note.noteKey }) }); showNotice('二级备注已删除'); await renderFinancialBrief({ trigger: 'notes' }); } catch (error) { button.disabled = false; showNotice(error.message, true); } });
};
const clearFinancialBriefAutoRefresh = () => { window.clearTimeout(financialBriefRefreshTimer); financialBriefRefreshTimer = null; };
const scheduleFinancialBriefAutoRefresh = () => {
  clearFinancialBriefAutoRefresh();
  if (state.page !== financialBriefModuleKey) return;
  financialBriefRefreshTimer = window.setTimeout(() => {
    financialBriefRefreshTimer = null;
    if (state.page !== financialBriefModuleKey) return;
    if (document.visibilityState === 'visible') renderFinancialBrief({ trigger: 'auto' });
    else scheduleFinancialBriefAutoRefresh();
  }, financialBriefAutoRefreshMs);
};
const clearConsultantRoiAutoRefresh = () => { window.clearTimeout(consultantRoiRefreshTimer); consultantRoiRefreshTimer = null; };
const scheduleConsultantRoiAutoRefresh = () => {
  clearConsultantRoiAutoRefresh();
  if (state.page !== consultantRoiModuleKey) return;
  consultantRoiRefreshTimer = window.setTimeout(() => {
    consultantRoiRefreshTimer = null;
    if (state.page !== consultantRoiModuleKey) return;
    if (document.visibilityState === 'visible') renderConsultantRoiInteractive({ trigger: 'auto' });
    else scheduleConsultantRoiAutoRefresh();
  }, consultantRoiAutoRefreshMs);
};

async function renderFinancialBrief({ trigger = 'initial' } = {}) {
  const page = $('#financial-brief-page');
  if (financialBriefRefreshInFlight) return;
  clearFinancialBriefAutoRefresh();
  const scope = { company: state.company, period: state.period }; const revision = ++financialBriefRequestRevision;
  const isCurrent = () => revision === financialBriefRequestRevision && state.page === financialBriefModuleKey && state.company === scope.company && state.period === scope.period;
  const existingSheet = page.querySelector('.financial-brief-sheet'); const existingButton = $('#financial-brief-refresh'); const existingStatus = $('#financial-brief-refresh-status');
  financialBriefRefreshInFlight = true; page.setAttribute('aria-busy', 'true');
  if (existingButton) { existingButton.disabled = true; existingButton.classList.add('refreshing'); existingButton.innerHTML = '<span aria-hidden="true">↻</span>刷新中…'; }
  if (existingStatus) existingStatus.textContent = trigger === 'auto' ? '正在自动检查最新已发布数据…' : '正在读取最新已发布数据…';
  try {
    const brief = await api(`/api/analysis/financial-brief?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}`);
    if (!isCurrent()) return;
    const [year, month] = String(brief.period || scope.period).split('-');
    const missing = (brief.missing || []).length ? `<div class="financial-brief-warning"><strong>部分来源尚未齐全</strong><span>${escapeHtml(brief.missing.join('；'))}<small>新报表发布后会自动补刷新，也可点击“刷新数据”立即检查。</small></span></div>` : '';
    const sources = (brief.sources || []).map(source => `<li><strong>${escapeHtml(source.report)}</strong><span>${escapeHtml(source.scope || brief.company)} · ${escapeHtml(source.fileName)}</span></li>`).join('');
    const refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    page.innerHTML = `<div class="page-title"><div><h1>财务数据简报</h1><p>${escapeHtml(brief.company)} · ${escapeHtml(brief.period)}</p></div><div class="financial-brief-page-actions">${filterHtml()}<div class="financial-brief-refresh-control"><button class="button financial-brief-refresh" id="financial-brief-refresh" type="button"><span aria-hidden="true">↻</span>刷新数据</button><small id="financial-brief-refresh-status">${escapeHtml(refreshedAt)} 已更新 · 每 60 秒自动刷新</small></div></div></div><article class="financial-brief-sheet"><header><div class="financial-brief-heading"><span>FINANCIAL BRIEF</span><h2>${escapeHtml(year)}年${Number(month)}月收支部分明细</h2><p>${escapeHtml(brief.scopeLabel)}</p></div><button class="button financial-brief-copy-button" id="financial-brief-copy-button" type="button" title="复制简报纯文字到剪贴板"><i aria-hidden="true">▣</i>复制纯文字</button></header>${missing}<div class="financial-brief-copy">${financialBriefRowsHtml(brief)}</div><footer><h3>本期其他数据来源</h3><ul>${sources || '<li><span>当前期间尚无其他可用来源文件</span></li>'}</ul><small>简报仅使用当前期间的已发布版本；缺失项不会按 0 处理，也不会复用其他月份数据。</small></footer></article>`;
    bindCommonFilters(); bindFinancialBriefActions(brief); applyReportWatermark();
  } catch (error) {
    if (!isCurrent()) return;
    if (existingSheet) { showNotice(`简报刷新失败：${error.message}`, true); if (existingStatus) existingStatus.textContent = '刷新失败，稍后将自动重试'; if (existingButton) { existingButton.disabled = false; existingButton.classList.remove('refreshing'); existingButton.innerHTML = '<span aria-hidden="true">↻</span>刷新数据'; } }
    else { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br><button class="button" id="financial-brief-retry" type="button">重新加载</button></div>`; $('#financial-brief-retry').onclick = () => renderFinancialBrief({ trigger: 'manual' }); }
  } finally {
    page.removeAttribute('aria-busy'); financialBriefRefreshInFlight = false; if (state.page === financialBriefModuleKey) scheduleFinancialBriefAutoRefresh();
  }
}

async function renderCashAnalysis() {
  const page = $('#analysis-page');
  const revision = pageRequestRevision; const scope = { company: state.company, period: state.period };
  try {
    const analysis = await api(`/api/analysis/cash-flow?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}&year=${encodeURIComponent(scope.period.slice(0, 4))}`);
    if (revision !== pageRequestRevision || state.page !== 'cash_analysis' || state.company !== scope.company || state.period !== scope.period) return;
    const cashFlow = { lines: [] };
    if (analysis.source?.noData) { renderMissingData(page, '资产净额分析', '科目余额表'); return; }
    const m = analysis.metrics || {}; const positions = analysis.internalPositions || []; const cashAccounts = analysis.cashAccounts || []; const otherItems = analysis.otherCurrentItems || []; const trend = analysis.monthlyTrend || [];
    const amountClass = value => Number(value || 0) < 0 ? 'negative' : 'positive'; const amountText = value => `${Number(value || 0) < 0 ? '-' : ''}¥${statementAmount(Math.abs(Number(value || 0)))}`;
    const componentsFor = item => ({ receivable: Number(item.receivable || 0), otherReceivable: Number(item.otherReceivable || 0), payable: Number(item.payable || 0), otherPayable: Number(item.otherPayable || 0) });
    const componentTotals = positions.reduce((total, item) => { const values = componentsFor(item); Object.keys(total).forEach(key => { total[key] += values[key]; }); return total; }, { receivable: Number(m.customerReceivables || 0), otherReceivable: 0, payable: Number(m.costPayables || 0), otherPayable: 0 });
    const positionRows = [...positions.map(item => ({ name: item.party, amount: item.net, nature: item.net >= 0 ? '净应收' : '净应付', note: '同一主体的应收账款、其他应收款、应付账款及其他应付款抵扣', search: item.party, accountCodes: item.accountCodes || [], components: componentsFor(item) })), { name: '其他客户应收', amount: m.customerReceivables, nature: '净应收', note: '客户应收账款，不与其他主体跨项抵扣', search: '应收账款', components: { receivable: Number(m.customerReceivables || 0), otherReceivable: 0, payable: 0, otherPayable: 0 } }, { name: '外部佣金及项目成本应付', amount: -Number(m.costPayables || 0), nature: '净应付', note: '佣金和项目成本供应商应付', search: '应付账款', components: { receivable: 0, otherReceivable: 0, payable: Number(m.costPayables || 0), otherPayable: 0 } }, { name: '应收应付整体净头寸', amount: m.receivablesPayablesNet, nature: m.receivablesPayablesNet >= 0 ? '净应收' : '净应付', note: '应收账款＋其他应收款－应付账款－其他应付款；不含预付、预收、职工薪酬及其他非往来项目', components: componentTotals, total: true }];
    const componentText = value => Math.abs(Number(value || 0)) > 0.000001 ? amountText(value) : '—';
    cashFlow.lines = (cashFlow.lines || []).filter(item => Math.abs(Number(item.current || 0)) > 0.000001);
    const cashMax = Math.max(...cashFlow.lines.map(item => Math.abs(item.current)), 1);
    page.innerHTML = `<div class="page-title"><div><h1>现金流分析</h1><p>${escapeHtml(analysis.company || currentCompanyName())} · ${state.period} · 现金流量与期末应收应付净头寸</p></div>${filterHtml()}</div><div class="liquidity-card-grid"><div class="card"><div class="metric-label">货币资金</div><div class="metric-value">${amountText(m.cash)}</div><div class="metric-change">银行及现金账户期末余额</div></div><div class="card"><div class="metric-label">内部往来净头寸</div><div class="metric-value ${amountClass(m.internalNet)}">${amountText(m.internalNet)}</div><div class="metric-change">同一集团主体抵扣后</div></div><div class="card"><div class="metric-label">应收应付整体净头寸</div><div class="metric-value ${amountClass(m.receivablesPayablesNet)}">${amountText(m.receivablesPayablesNet)}</div><div class="metric-change">客户、成本与内部往来合计</div></div><div class="card"><div class="metric-label">静态流动性金额</div><div class="metric-value ${amountClass(m.staticLiquidity)}">${amountText(m.staticLiquidity)}</div><div class="metric-change">货币资金＋整体净头寸</div></div><div class="card core-liquidity-card"><div class="metric-label">核心净流动性头寸</div><div class="metric-value ${amountClass(m.coreNetLiquidity)}">${amountText(m.coreNetLiquidity)}</div><div class="metric-change">不含客户应收及成本应付</div></div></div><section class="panel analysis-source"><strong>指标口径</strong><span>核心净流动性头寸＝货币资金＋内部往来净头寸；剔除客户应收账款及外部佣金、项目成本应付，用于观察不依赖客户回款、也不考虑成本支付后的基础流动性。</span><small>来源：${escapeHtml(analysis.source?.fileName || '—')} · ${escapeHtml(analysis.source?.sourceSheet || '—')}${analysis.source?.demo ? ' · 模板演示，发布后以用户上传数据为准' : ''}</small></section><div class="two-col"><section class="panel"><h2>应收应付抵扣后期末余额</h2><div class="panel-sub">仅同一往来主体抵扣，不跨客户或供应商抵扣</div><div class="table-wrap"><table class="data-table analysis-table"><thead><tr><th>项目</th><th>期末净额</th><th>性质</th><th>说明</th></tr></thead><tbody>${positionRows.map(row => `<tr class="${row.total ? 'analysis-total' : ''}"><td>${row.search ? `<button class="analysis-drill" data-analysis-search="${escapeHtml(row.search)}" data-analysis-codes="${escapeHtml((row.accountCodes || []).join(','))}">${escapeHtml(row.name)}</button>` : escapeHtml(row.name)}</td><td class="num ${amountClass(row.amount)}">${amountText(row.amount)}</td><td><span class="position-badge ${row.amount < 0 ? 'payable' : 'receivable'}">${escapeHtml(row.nature)}</span></td><td class="analysis-note">${escapeHtml(row.note)}</td></tr>`).join('')}</tbody></table></div></section><section class="panel"><h2>现金流量结构</h2><div class="panel-sub">经营、投资和筹资活动现金流辅助视图</div><div class="bar-chart">${(cashFlow.lines || []).map(line => `<div class="bar-row"><div class="bar-label">${escapeHtml(line.name)}</div><div class="bar-track"><div class="bar-fill ${line.current < 0 ? 'negative-bar' : ''}" style="width:${Math.min(100, Math.abs(line.current) / cashMax * 100)}%"></div></div><div class="bar-value ${amountClass(line.current)}">${amountText(line.current)}</div></div>`).join('') || '<div class="empty">当前期间暂无现金流量表汇总数据</div>'}</div></section></div><div class="two-col"><section class="panel"><h2>货币资金账户</h2><div class="panel-sub">科目余额表中的银行及现金明细</div><div class="identity-list">${cashAccounts.map(item => `<div class="identity-row"><button class="analysis-drill" data-analysis-search="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button><strong>${amountText(item.balance)}</strong></div>`).join('') || '<div class="empty">暂无账户明细</div>'}</div></section><section class="panel"><h2>其他流动项目</h2><div class="panel-sub">不计入应收应付整体净头寸，仅作账表观察</div><div class="identity-list">${otherItems.map(item => `<div class="identity-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.nature)}</small></div><strong>${amountText(item.amount)}</strong></div>`).join('')}</div></section></div>`;
    page.innerHTML = page.innerHTML
      .replaceAll('现金流分析', '资产净额分析')
      .replaceAll('现金流量与期末应收应付净头寸', '资产净额与流动性结构')
      .replaceAll('内部往来净头寸', '内部往来净额')
      .replaceAll('应收应付整体净头寸', '应收应付净额')
      .replaceAll('静态流动性金额', '静态流动性净额')
      .replaceAll('核心净流动性头寸', '核心流动性净额')
      .replaceAll('银行及现金账户期末余额', '银行及现金账户可动用资金')
      .replaceAll('同一集团主体抵扣后', '集团内部往来抵扣后')
      .replaceAll('客户、成本与内部往来合计', '全部应收应付抵扣后')
      .replaceAll('货币资金＋整体净头寸', '货币资金＋应收应付净额')
      .replaceAll('指标口径', '资金口径')
      .replaceAll('应收应付抵扣后期末余额', '应收应付净额构成');
    page.querySelector('.analysis-source span')?.replaceChildren(document.createTextNode('核心流动性净额＝货币资金＋内部往来净额；静态流动性净额＝货币资金＋应收应付净额。核心口径剔除客户应收及外部佣金、项目成本应付，用于观察基础可动用资金。'));
    const netPositionPanel = [...page.querySelectorAll(':scope > .two-col > .panel')].find(panel => panel.querySelector('h2')?.textContent?.trim() === '应收应付净额构成');
    if (netPositionPanel) {
      netPositionPanel.classList.add('net-position-panel');
      const heading = netPositionPanel.querySelector('h2'); const subtitle = netPositionPanel.querySelector('.panel-sub'); const toolbar = document.createElement('div'); const titleWrap = document.createElement('div');
      toolbar.className = 'toolbar net-position-toolbar'; titleWrap.append(heading, subtitle); toolbar.append(titleWrap); toolbar.insertAdjacentHTML('beforeend', '<button class="button ghost analysis-components-toggle" type="button" aria-expanded="false">展开净额构成 <span aria-hidden="true">›</span></button>'); netPositionPanel.prepend(toolbar);
      const table = netPositionPanel.querySelector('.analysis-table'); table?.classList.add('net-position-table');
      const headerRow = table?.querySelector('thead tr'); if (headerRow) headerRow.innerHTML = '<th>项目</th><th>期末净额</th><th>性质</th><th class="analysis-component-col">应收账款</th><th class="analysis-component-col">其他应收款</th><th class="analysis-component-col component-deduction">应付账款（减）</th><th class="analysis-component-col component-deduction">其他应付款（减）</th><th class="analysis-note-heading" title="点击每行问号查看说明">说明</th>';
      const body = table?.querySelector('tbody'); if (body) body.innerHTML = positionRows.map(row => `<tr class="${row.total ? 'analysis-total' : ''}"><td>${row.search ? `<button class="analysis-drill" data-analysis-search="${escapeHtml(row.search)}" data-analysis-codes="${escapeHtml((row.accountCodes || []).join(','))}">${escapeHtml(row.name)}</button>` : escapeHtml(row.name)}</td><td class="num ${amountClass(row.amount)}">${amountText(row.amount)}</td><td><span class="position-badge ${row.amount < 0 ? 'payable' : 'receivable'}">${escapeHtml(row.nature)}</span></td><td class="num analysis-component-col receivable-component">${componentText(row.components?.receivable)}</td><td class="num analysis-component-col receivable-component">${componentText(row.components?.otherReceivable)}</td><td class="num analysis-component-col payable-component">${componentText(row.components?.payable)}</td><td class="num analysis-component-col payable-component">${componentText(row.components?.otherPayable)}</td><td class="analysis-note"><details class="analysis-help"><summary aria-label="查看${escapeHtml(row.name)}说明">?</summary><div class="analysis-help-popover">${escapeHtml(row.note)}</div></details></td></tr>`).join('');
      const toggle = netPositionPanel.querySelector('.analysis-components-toggle'); toggle?.addEventListener('click', () => { const expanded = netPositionPanel.classList.toggle('components-expanded'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.innerHTML = expanded ? '收起净额构成 <span aria-hidden="true">‹</span>' : '展开净额构成 <span aria-hidden="true">›</span>'; });
    }
    [...page.querySelectorAll(':scope > .two-col > .panel')].find(panel => panel.querySelector('h2')?.textContent?.trim() === '现金流量结构')?.remove();
    page.querySelector('.liquidity-card-grid')?.insertAdjacentHTML('afterend', `<div class="liquidity-composition-guide"><div class="liquidity-guide-row core"><span class="liquidity-guide-part">货币资金</span><span class="liquidity-guide-plus">＋</span><span class="liquidity-guide-part">内部往来净额</span><span class="liquidity-guide-arrow" aria-hidden="true"></span><strong>核心流动性净额</strong></div><div class="liquidity-guide-row static"><span class="liquidity-guide-part">货币资金</span><span class="liquidity-guide-plus">＋</span><span class="liquidity-guide-part">应收应付净额</span><span class="liquidity-guide-arrow" aria-hidden="true"></span><strong>静态流动性净额</strong></div></div>`);
    page.insertAdjacentHTML('beforeend', `<section class="panel business-trend-panel core-liquidity-trend-panel"><div class="toolbar"><div><h2>${escapeHtml(analysis.year || state.period.slice(0, 4))} 年核心流动性净额月度变动</h2><div class="panel-sub">按每月已发布科目余额表计算；未上传月份留空，不按零值处理</div></div></div>${coreLiquidityTrendSvg(trend)}</section>`);
    const layout = document.createElement('div'); layout.className = 'analysis-layout-grid cash-analysis-layout'; page.querySelector('.page-title')?.after(layout);
    const cashCardKeys = { '货币资金': 'cash_metric', '内部往来净额': 'internal_metric', '核心流动性净额': 'core_metric', '应收应付净额': 'receivables_metric', '静态流动性净额': 'static_metric' };
    const metricGrid = page.querySelector('.liquidity-card-grid'); [...(metricGrid?.children || [])].forEach(card => { card.dataset.analysisBlock = cashCardKeys[card.querySelector('.metric-label')?.textContent?.trim()] || ''; card.classList.add('analysis-span-3'); layout.appendChild(card); }); metricGrid?.remove();
    const guide = page.querySelector('.liquidity-composition-guide'); if (guide) { guide.dataset.analysisBlock = 'liquidity_guide'; guide.classList.add('analysis-span-12'); layout.appendChild(guide); }
    const sourceBlock = page.querySelector('.analysis-source'); if (sourceBlock) { sourceBlock.dataset.analysisBlock = 'cash_source'; sourceBlock.classList.add('analysis-span-12'); layout.appendChild(sourceBlock); }
    const cashPanelKeys = ['net_positions', 'cash_accounts', 'other_liquidity']; const panelGroups = [...page.querySelectorAll(':scope > .two-col')]; panelGroups.flatMap(group => [...group.children]).forEach((panel, index) => { panel.dataset.analysisBlock = cashPanelKeys[index]; panel.classList.add(index === 0 ? 'analysis-span-12' : 'analysis-span-6'); layout.appendChild(panel); }); panelGroups.forEach(group => group.remove());
    const trendPanel = page.querySelector('.core-liquidity-trend-panel'); if (trendPanel) { trendPanel.dataset.analysisBlock = 'core_liquidity_trend'; trendPanel.classList.add('analysis-span-12'); layout.appendChild(trendPanel); }
    applyAnalysisBlockLayout(layout, 'cash_analysis');
    bindCommonFilters(); document.querySelectorAll('[data-analysis-search]').forEach(button => button.onclick = () => { state.reportType = 'trial_balance'; openRawDetail(button.dataset.analysisSearch, '', String(button.dataset.analysisCodes || '').split(',').filter(Boolean)); });
  } catch (error) { if (revision !== pageRequestRevision || state.page !== 'cash_analysis') return; page.innerHTML = `<div class="page-title"><div><h1>资产净额分析</h1><p>${escapeHtml(currentCompanyName())} · ${state.period}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}</div>`; bindCommonFilters(); }
}

const businessCurrency = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const businessRate = value => value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`;
const businessCompactCurrency = value => {
  const numeric = Number(value || 0); const amount = Math.abs(numeric); const sign = numeric < 0 ? '-' : '';
  if (amount >= 100000000) return `${sign}¥${(amount / 100000000).toFixed(2)}亿`;
  if (amount >= 10000) return `${sign}¥${(amount / 10000).toFixed(2)}万`;
  return `${sign}¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const coreLiquidityTrendSvg = trend => {
  const months = Array.isArray(trend) ? trend : []; const width = 1040; const height = 326; const left = 58; const right = 24; const top = 50; const bottom = 44; const plotBottom = height - bottom - 12;
  const actual = months.filter(item => item.available && Number.isFinite(Number(item.coreNetLiquidity))); const values = actual.map(item => Number(item.coreNetLiquidity));
  if (!values.length) return '<div class="business-trend core-liquidity-trend-empty"><div class="empty">当前年度暂无已发布的科目余额表</div></div>';
  let minValue = Math.min(...values); let maxValue = Math.max(...values); const rawRange = maxValue - minValue; const padding = rawRange > 0 ? rawRange * .14 : Math.max(Math.abs(maxValue) * .12, 1); minValue -= padding; maxValue += padding;
  const innerW = width - left - right; const range = Math.max(maxValue - minValue, 1); const x = index => left + (innerW * index / Math.max(1, months.length - 1)); const y = value => top + ((maxValue - Number(value)) / range) * (plotBottom - top);
  const segments = []; let current = [];
  months.forEach((item, index) => { if (item.available && Number.isFinite(Number(item.coreNetLiquidity))) current.push({ index, value: Number(item.coreNetLiquidity), month: item.month }); else if (current.length) { segments.push(current); current = []; } }); if (current.length) segments.push(current);
  const guides = [0.25, 0.5, 0.75].map(ratio => { const yy = top + (plotBottom - top) * ratio; return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" class="trend-guide"/>`; }).join('');
  const areas = segments.filter(segment => segment.length > 1).map(segment => `<polygon points="${x(segment[0].index).toFixed(1)},${plotBottom} ${segment.map(point => `${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')} ${x(segment.at(-1).index).toFixed(1)},${plotBottom}" class="trend-core-area"/>`).join('');
  const lines = segments.filter(segment => segment.length > 1).map(segment => `<polyline points="${segment.map(point => `${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}" class="trend-line trend-core-liquidity" filter="url(#core-liquidity-glow)"/>`).join('');
  const points = actual.map(item => { const index = months.indexOf(item); const value = Number(item.coreNetLiquidity); const pointY = y(value); const labelY = Math.max(20, Math.min(plotBottom - 9, pointY - 12)); return `<g class="trend-series-point core-liquidity"><circle cx="${x(index)}" cy="${pointY}" r="5"/><text x="${x(index)}" y="${labelY}" class="trend-value-label core-liquidity">${businessCompactCurrency(value)}</text><title>${item.month} · 核心流动性净额 ${businessCurrency(value)}</title></g>`; }).join('');
  const labels = months.map((item, index) => `<text x="${x(index)}" y="${height - 17}" class="trend-label">${String(item.month || '').slice(5)}月</text>`).join('');
  const zeroLine = minValue <= 0 && maxValue >= 0 ? `<line x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" class="trend-zero"/>` : '';
  return `<div class="business-trend"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="核心流动性净额月度趋势"><defs><linearGradient id="core-liquidity-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#41e2c5" stop-opacity=".72"/><stop offset="1" stop-color="#1d78e9" stop-opacity=".08"/></linearGradient><filter id="core-liquidity-glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="0" y="0" width="${width}" height="${height}" rx="18" class="trend-bg"/>${guides}${zeroLine}${areas}${lines}${points}${labels}</svg><div class="trend-legend"><span><i class="legend-dot core-liquidity"></i>核心流动性净额</span><small>按实际数据区间突出月度变化，缺报月份断开显示</small></div></div>`;
};
const businessTrendSvg = trend => {
  const width = 1040; const height = 326; const left = 58; const right = 24; const top = 50; const bottom = 44; const innerW = width - left - right; const innerH = height - top - bottom;
  const grossValues = trend.map(item => Number(item.grossProfit || 0)); const minValue = Math.min(0, ...grossValues); const maxValue = Math.max(0, ...grossValues); const range = Math.max(maxValue - minValue, 1); const plotTop = top + 8; const plotBottom = height - bottom - 12;
  const x = index => left + (innerW * index / Math.max(1, trend.length - 1)); const y = value => plotTop + ((maxValue - Number(value || 0)) / range) * (plotBottom - plotTop);
  const line = key => trend.map((item, index) => `${x(index).toFixed(1)},${y(Number(item[key] || 0)).toFixed(1)}`).join(' ');
  const zeroY = y(0); const areaPoints = `${left},${zeroY} ${line('grossProfit')} ${x(trend.length - 1)},${zeroY}`;
  const guides = [0.25, 0.5, 0.75].map(ratio => { const yy = top + innerH * ratio; return `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" class="trend-guide"/>`; }).join('');
  const pointsAndLabels = trend.map((item, index) => {
    const value = Number(item.grossProfit || 0); if (Math.abs(value) < 0.000001) return '';
    const pointY = y(value); const labelY = Math.max(20, Math.min(height - bottom - 8, pointY - 12));
    return `<g class="trend-series-point gross"><circle cx="${x(index)}" cy="${pointY}" r="5"/><text x="${x(index)}" y="${labelY}" class="trend-value-label gross">毛利 ${businessCompactCurrency(value)}</text><title>${item.month} · 毛利 ${businessCurrency(value)}</title></g>`;
  }).join('');
  const monthLabels = trend.map((item, index) => `<text x="${x(index)}" y="${height - 17}" class="trend-label">${item.month.slice(5)}月</text>`).join('');
  return `<div class="business-trend"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="主营业务毛利月度趋势"><defs><linearGradient id="gross-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#41e2c5" stop-opacity=".72"/><stop offset="1" stop-color="#1d78e9" stop-opacity=".08"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="0" y="0" width="${width}" height="${height}" rx="18" class="trend-bg"/>${guides}<line x1="${left}" x2="${width - right}" y1="${zeroY}" y2="${zeroY}" class="trend-zero"/><polygon points="${areaPoints}" class="trend-area"/><polyline points="${line('grossProfit')}" class="trend-line trend-gross" filter="url(#glow)"/>${pointsAndLabels}${monthLabels}</svg><div class="trend-legend"><span><i class="legend-dot gross"></i>毛利</span><small>按毛利自身区间突出月度变化，非零月份已标注金额</small></div></div>`;
};

const groupTrendCompactMoney = value => {
  const amount = Number(value || 0); const absolute = Math.abs(amount);
  if (absolute >= 100000000) return `${(amount / 100000000).toFixed(1)}亿`;
  if (absolute >= 10000) return `${(amount / 10000).toFixed(1)}万`;
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
};
const groupTrendFullMoney = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const groupTrendChart = (monthly, series, ariaLabel, note) => {
  const rows = [...(monthly || [])].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  if (!rows.length) return '<div class="group-trend-empty">当前年度暂无已发布的集团合并利润表</div>';
  const width = 960; const height = 320; const left = 72; const right = 34; const top = 36; const bottom = 54;
  const values = rows.flatMap(row => series.map(item => Number(row[item.key] || 0))); let min = Math.min(...values); let max = Math.max(...values);
  if (min === max) { const padding = Math.max(Math.abs(max) * .15, 1); min -= padding; max += padding; }
  else { const padding = (max - min) * .12; min -= padding; max += padding; }
  const x = index => rows.length === 1 ? (left + width - right) / 2 : left + index * (width - left - right) / (rows.length - 1);
  const y = value => top + (max - Number(value || 0)) / (max - min) * (height - top - bottom);
  const guides = Array.from({ length: 5 }, (_, index) => { const value = max - index * (max - min) / 4; const guideY = y(value); return `<line x1="${left}" x2="${width - right}" y1="${guideY.toFixed(1)}" y2="${guideY.toFixed(1)}" class="trend-guide"/><text x="${left - 10}" y="${(guideY + 4).toFixed(1)}" class="group-trend-axis-label">${escapeHtml(groupTrendCompactMoney(value))}</text>`; }).join('');
  const lines = series.map(item => `<polyline points="${rows.map((row, index) => `${x(index).toFixed(1)},${y(row[item.key]).toFixed(1)}`).join(' ')}" class="group-trend-series" style="stroke:${item.color};stroke-width:${item.width || 2.5};${item.dash ? `stroke-dasharray:${item.dash}` : ''}"/>`).join('');
  const points = series.map((item, seriesIndex) => rows.map((row, index) => { const value = Number(row[item.key] || 0); const pointX = x(index); const pointY = y(value); const labeledSeries = series.filter(candidate => candidate.labelValues); const labelIndex = labeledSeries.findIndex(candidate => candidate.key === item.key); const labelOffset = labeledSeries.length > 1 ? (labelIndex === 0 ? -13 : 19) : -13; const tilted = rows.length > 6; const label = item.labelValues ? `<text x="${pointX.toFixed(1)}" y="${(pointY + labelOffset).toFixed(1)}" class="group-trend-value${tilted ? ' tilted' : ''}" ${tilted ? `transform="rotate(-32 ${pointX.toFixed(1)} ${(pointY + labelOffset).toFixed(1)})"` : ''}>${escapeHtml(groupTrendCompactMoney(value))}</text>` : ''; return `<g><circle cx="${pointX.toFixed(1)}" cy="${pointY.toFixed(1)}" r="4" class="group-trend-point" style="fill:${item.color}"><title>${escapeHtml(row.period)} ${escapeHtml(item.label)}：${escapeHtml(groupTrendFullMoney(value))} 元</title></circle>${label}</g>`; }).join('')).join('');
  const months = rows.map((row, index) => `<text x="${x(index).toFixed(1)}" y="${height - 19}" class="trend-label">${escapeHtml(String(row.period).slice(5))}月</text>`).join('');
  const legend = series.map(item => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join('');
  return `<div class="group-trend-chart"><div class="group-trend-mobile-cue" aria-hidden="true">← 左右滑动查看完整趋势 →</div><div class="group-trend-scroll" role="region" aria-label="${escapeHtml(ariaLabel)}，可左右滑动" tabindex="0"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}"><rect x="0" y="0" width="${width}" height="${height}" rx="18" class="trend-bg"/>${guides}${lines}${points}${months}</svg></div><div class="group-trend-legend">${legend}<small>${escapeHtml(note)}</small></div></div>`;
};

async function renderGroupProfitAnalysis() {
  const page = $('#group-profit-analysis-page');
  try {
    const analysis = await api(`/api/analysis/group-profit-trends?company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}&year=${encodeURIComponent(state.period.slice(0, 4))}`);
    if (analysis.source?.noData) { renderMissingData(page, '集团合并利润趋势图', '桉侨集团合并利润表'); return; }
    const monthly = analysis.monthly || []; const sourceFiles = (analysis.source?.files || []).join('、') || '—';
    const panel = (key, title, subtitle, chart) => `<section class="panel group-profit-trend-panel" data-group-profit-panel="${key}"><div class="toolbar"><div><h2>${escapeHtml(title)}</h2><div class="panel-sub">${escapeHtml(subtitle)}</div></div></div>${chart}</section>`;
    page.innerHTML = `<div class="page-title"><div><h1>集团合并利润趋势图</h1><p>${escapeHtml(analysis.company || currentCompanyName())} · ${escapeHtml(analysis.year)} 年 · 截至 ${escapeHtml(analysis.period)}</p></div>${filterHtml()}</div><section class="analysis-source group-profit-source"><strong>数据来源</strong><span>${escapeHtml(sourceFiles)}</span><small>按各月已发布的桉侨集团合并利润表本期金额取数；未上传月份不展示，选择历史期间时不读取之后月份。</small></section>${panel('revenue_cost_trend', '营业收入和营业成本趋势图', '双线比较集团营业规模与成本变化 · 金额单位：元', groupTrendChart(monthly, [{ key: 'revenue', label: '营业收入', color: '#70adff', width: 3.2, labelValues: true }, { key: 'cost', label: '营业成本', color: '#ffad7a', width: 3, labelValues: true }], '集团营业收入和营业成本趋势', '数值标签随月份密度自动横置或倾斜'))}${panel('period_expense_trend', '期间费用趋势图', '销售费用、管理费用、财务费用及合计 · 金额单位：元', groupTrendChart(monthly, [{ key: 'sellingExpense', label: '销售费用', color: '#ffb968', dash: '6 4' }, { key: 'administrationExpense', label: '管理费用', color: '#9b8cff', dash: '6 4' }, { key: 'financeExpense', label: '财务费用', color: '#58c8ff', dash: '6 4' }, { key: 'periodExpense', label: '期间费用合计', color: '#35e0bf', width: 3.6, labelValues: true }], '集团期间费用趋势', '期间费用合计 = 销售费用 + 管理费用 + 财务费用'))}${panel('net_profit_trend', '净利润趋势图', '集团合并净利润月度变化 · 金额单位：元', groupTrendChart(monthly, [{ key: 'netProfit', label: '净利润', color: '#35e0bf', width: 3.8, labelValues: true }], '集团净利润趋势', '正负净利润按同一纵轴展示'))}`;
    const layout = document.createElement('div'); layout.className = 'analysis-layout-grid group-profit-analysis-layout'; page.querySelector('.page-title')?.after(layout);
    const source = page.querySelector('.group-profit-source'); if (source) { source.dataset.analysisBlock = 'group_profit_source'; source.classList.add('analysis-span-12'); layout.appendChild(source); }
    page.querySelectorAll('[data-group-profit-panel]').forEach(item => { item.dataset.analysisBlock = item.dataset.groupProfitPanel; item.classList.add('analysis-span-12'); layout.appendChild(item); });
    applyAnalysisBlockLayout(layout, 'group_profit_analysis'); bindCommonFilters();
    if (window.matchMedia?.('(max-width: 700px)').matches) requestAnimationFrame(() => page.querySelectorAll('.group-trend-scroll').forEach(scroller => { scroller.scrollLeft = monthly.length === 1 ? Math.max(0, (scroller.scrollWidth - scroller.clientWidth) / 2) : Math.max(0, scroller.scrollWidth - scroller.clientWidth); }));
  } catch (error) { page.innerHTML = `<div class="page-title"><div><h1>集团合并利润趋势图</h1><p>${escapeHtml(currentCompanyName())} · ${escapeHtml(state.period)}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}</div>`; bindCommonFilters(); }
}

async function renderMainBusinessAnalysis() {
  const page = $('#business-analysis-page');
  const revision = pageRequestRevision; const scope = { company: state.company, period: state.period };
  try {
    const analysis = await api(`/api/analysis/main-business?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}&year=${encodeURIComponent(scope.period.slice(0, 4))}`);
    if (revision !== pageRequestRevision || state.page !== 'main_business_analysis' || state.company !== scope.company || state.period !== scope.period) return;
    if (analysis.source?.noData) { renderMissingData(page, '主营业务分析', '序时账'); return; }
    const detailRows = analysis.detailRows || []; const projectRows = analysis.projectRows || []; const trend = analysis.monthlyTrend || [];
    const revenue = analysis.current?.revenue || 0; const cost = analysis.current?.cost || 0; const gross = revenue - cost; const projectMax = Math.max(...projectRows.flatMap(row => [row.currentProjectCount, row.previousProjectCount]), 1);
    const sourceText = `${analysis.source?.fileName || '—'} · ${analysis.source?.sourceSheet || '—'}${analysis.source?.demo ? ' · 演示原始资料，上传后自动切换为发布批次' : ` · 上传批次 ${analysis.source?.uploadKey || '—'}`}`;
    const detailHtml = detailRows.map(row => `<tr><td class="num">${row.index}</td><td>${escapeHtml(row.contractNo)}</td><td>${escapeHtml(row.customerName || '未识别客户')}</td><td>${escapeHtml(row.projectName)}</td><td class="num">${businessCurrency(row.revenue)}</td><td class="num">${businessCurrency(row.cost)}</td><td class="num ${row.grossMargin !== null && row.grossMargin < 0 ? 'negative' : 'positive'}">${businessRate(row.grossMargin)}</td></tr>`).join('');
    const projectHtml = projectRows.map(row => { const diff = row.currentProjectCount - row.previousProjectCount; return `<tr><td>${escapeHtml(row.projectName)}</td><td class="project-gauge-cell"><div class="project-gauge current"><span class="project-gauge-fill" style="width:${row.currentProjectCount / projectMax * 100}%"></span><strong>${row.currentProjectCount}</strong></div></td><td class="project-gauge-cell"><div class="project-gauge previous"><span class="project-gauge-fill" style="width:${row.previousProjectCount / projectMax * 100}%"></span><strong>${row.previousProjectCount}</strong></div></td><td class="num ${diff >= 0 ? 'positive' : 'negative'}">${row.changeRate === null ? (row.currentProjectCount ? '新增' : '—') : `${row.changeRate >= 0 ? '+' : ''}${businessRate(row.changeRate)}`}</td></tr>`; }).join('');
    page.innerHTML = `<div class="page-title"><div><h1>主营业务分析</h1><p>${escapeHtml(analysis.company || currentCompanyName())} · ${escapeHtml(analysis.period)} · 本期确认口径</p></div>${filterHtml()}</div><section class="analysis-source business-source"><strong>数据来源</strong><span>${escapeHtml(sourceText)}</span><small>收入取主营业务收入贷方，成本取主营业务成本借方；项目数量按唯一合同编号统计，上期为 ${escapeHtml(analysis.previousPeriod || '—')}。</small></section><div class="card-grid business-card-grid"><div class="card business-card revenue-card"><div class="metric-label">本期确认收入</div><div class="metric-value">${businessCurrency(revenue)}</div><div class="metric-change">主营业务收入贷方</div></div><div class="card business-card cost-card"><div class="metric-label">本期确认成本</div><div class="metric-value">${businessCurrency(cost)}</div><div class="metric-change">主营业务成本借方</div></div><div class="card business-card gross-card"><div class="metric-label">本期毛利</div><div class="metric-value ${gross < 0 ? 'negative' : 'positive'}">${businessCurrency(gross)}</div><div class="metric-change">收入 − 成本</div></div><div class="card business-card"><div class="metric-label">确认项目数</div><div class="metric-value">${Number(analysis.current?.projectCount || 0)}</div><div class="metric-change">按合同与项目归类</div></div></div><section class="panel business-panel"><div class="toolbar"><div><h2>本月确认的项目主营业务收入成本</h2><div class="panel-sub">毛利率 =（本期确认收入 − 本期确认成本）÷ 本期确认收入</div></div></div><div class="table-wrap"><table class="data-table business-detail-table"><thead><tr><th>序号</th><th>合同编号</th><th>项目名称</th><th>本期确认收入</th><th>本期确认成本</th><th>毛利率</th></tr></thead><tbody>${detailHtml || '<tr><td colspan="6" class="empty">当前期间暂无主营业务分录</td></tr>'}</tbody></table></div></section><div class="two-col business-project-grid"><section class="panel business-panel"><div class="toolbar"><div><h2>项目数量变化</h2><div class="panel-sub">按项目名称归类，比较本期与上期项目数量</div></div></div><div class="table-wrap"><table class="data-table business-project-table"><thead><tr><th>项目名称</th><th>本期项目数量</th><th>上期项目数量</th><th>变动比率</th></tr></thead><tbody>${projectHtml || '<tr><td colspan="4" class="empty">暂无项目数量变化</td></tr>'}</tbody></table></div></section><section class="panel business-panel"><div class="project-chart-title"><span>项目数量对比</span><small><i class="legend-dot current"></i>本期　<i class="legend-dot previous"></i>上期</small></div><div class="business-project-bars">${projectRows.slice(0, 8).map(row => `<div class="project-bar-row"><div class="bar-label" title="${escapeHtml(row.projectName)}">${escapeHtml(row.projectName)}</div><div class="bar-track"><div class="bar-fill project-current-fill" style="width:${row.currentProjectCount / projectMax * 100}%"></div></div><strong>${row.currentProjectCount}</strong><div class="bar-track"><div class="bar-fill project-previous-fill" style="width:${row.previousProjectCount / projectMax * 100}%"></div></div><strong>${row.previousProjectCount}</strong></div>`).join('') || '<div class="empty">暂无项目数量数据</div>'}</div></section></div><section class="panel business-panel business-trend-panel"><div class="toolbar"><div><h2>${escapeHtml(analysis.year)} 年主营业务毛利月度变动</h2><div class="panel-sub">仅展示毛利主线，并按毛利自身区间突出月度态势变化</div></div></div>${businessTrendSvg(trend)}</section>${analysis.warnings?.length ? `<div class="business-warning">⚠ ${analysis.warnings.map(item => escapeHtml(item)).join('；')}</div>` : ''}`;
    const detailHeader = page.querySelector('.business-detail-table thead tr'); detailHeader?.querySelector('th:nth-child(2)')?.insertAdjacentHTML('afterend', '<th>客户名称</th>');
    const detailEmpty = page.querySelector('.business-detail-table td.empty'); if (detailEmpty) detailEmpty.colSpan = 7;
    const projectGrid = page.querySelector('.business-project-grid');
    projectGrid?.classList.add('merged');
    projectGrid?.querySelector(':scope > section:last-child')?.remove();
    const projectSubtitle = projectGrid?.querySelector('.panel-sub'); if (projectSubtitle) projectSubtitle.textContent = '按项目名称归类；条形长度按本期与上期最大项目数统一缩放，数字为精确项目数';
    projectGrid?.querySelector('.toolbar')?.insertAdjacentHTML('beforeend', '<div class="project-table-legend"><span><i class="legend-dot current"></i>本期</span><span><i class="legend-dot previous"></i>上期</span></div>');
    const layout = document.createElement('div'); layout.className = 'analysis-layout-grid'; page.querySelector('.page-title')?.after(layout);
    const sourceBlock = page.querySelector('.business-source'); if (sourceBlock) { sourceBlock.dataset.analysisBlock = 'business_source'; sourceBlock.classList.add('analysis-span-12'); layout.appendChild(sourceBlock); }
    const metricKeys = ['revenue_metric', 'cost_metric', 'gross_metric', 'project_count_metric']; const metricGrid = page.querySelector('.business-card-grid'); [...(metricGrid?.children || [])].forEach((card, index) => { card.dataset.analysisBlock = metricKeys[index]; card.classList.add('analysis-span-3'); layout.appendChild(card); }); metricGrid?.remove();
    const detailPanel = page.querySelector('.business-detail-table')?.closest('.business-panel'); if (detailPanel) { detailPanel.dataset.analysisBlock = 'business_detail'; detailPanel.classList.add('analysis-span-12'); layout.appendChild(detailPanel); }
    const projectPanel = projectGrid?.querySelector(':scope > section'); if (projectPanel) { projectPanel.dataset.analysisBlock = 'project_change'; projectPanel.classList.add('analysis-span-12'); layout.appendChild(projectPanel); } projectGrid?.remove();
    const trendPanel = page.querySelector('.business-trend-panel'); if (trendPanel) { trendPanel.dataset.analysisBlock = 'gross_trend'; trendPanel.classList.add('analysis-span-12'); layout.appendChild(trendPanel); }
    applyAnalysisBlockLayout(layout, 'main_business_analysis');
    bindCommonFilters();
  } catch (error) { if (revision !== pageRequestRevision || state.page !== 'main_business_analysis') return; page.innerHTML = `<div class="page-title"><div><h1>主营业务分析</h1><p>${escapeHtml(currentCompanyName())} · ${state.period}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}</div>`; bindCommonFilters(); }
}

const expenseMoney = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const expensePercent = value => value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`;
const expenseFeePercent = value => value === null || value === undefined ? '—' : `${Number(value).toFixed(2)}%`;
const expenseChangeClass = value => Number(value || 0) >= 0 ? 'positive' : 'negative';
const expenseMonthlyChart = (monthly, label) => {
  const visibleMonths = (monthly || []).filter(item => Math.abs(Number(item.amount || 0)) > 0.000001).sort((a, b) => String(b.month).localeCompare(String(a.month))); const max = Math.max(...visibleMonths.map(item => Math.abs(Number(item.amount || 0))), 1);
  return `<section class="panel expense-chart-panel"><div class="toolbar"><div><h3>${escapeHtml(label)}月度变动</h3><div class="panel-sub">${escapeHtml(monthly?.[0]?.month?.slice(0, 4) || '')} 年 · 仅展示有数据月份 · 最近月份在上 · 金额单位：元</div></div></div><div class="expense-monthly-chart">${visibleMonths.map(item => { const amount = Number(item.amount || 0); return `<div class="expense-month-row"><div class="expense-month-label">${item.month.slice(5)}月</div><div class="expense-month-track"><div class="expense-month-bar ${amount < 0 ? 'negative' : ''}" style="width:${Math.max(2, Math.abs(amount) / max * 100)}%" title="${item.month}：${expenseMoney(amount)}"></div></div><div class="expense-month-value">${expenseMoney(amount)}</div></div>`; }).join('') || '<div class="expense-monthly-empty">当前年度暂无费用数据</div>'}</div></section>`;
};
const expenseShareChart = (rows, label, valueKey = 'current', nameKey = 'name') => {
  const values = (rows || []).filter(row => Number(row[valueKey] || 0) > 0); const total = values.reduce((sum, row) => sum + Number(row[valueKey] || 0), 0) || 1; let cursor = 0;
  const colors = ['#2676e9', '#42b883', '#f5a623', '#9b6cff', '#e66a55', '#5c7cfa']; const stops = values.map((row, index) => { const start = cursor; cursor += Number(row[valueKey] || 0) / total * 360; return `${colors[index % colors.length]} ${start.toFixed(1)}deg ${cursor.toFixed(1)}deg`; }).join(', ');
  return `<section class="panel expense-share-panel"><div class="toolbar"><div><h3>${escapeHtml(label)}本期占比</h3><div class="panel-sub">按金额计算</div></div></div><div class="expense-share-wrap"><div class="expense-donut" style="background:conic-gradient(${stops || '#dce6f2 0 360deg'})"><span>${expenseMoney(total === 1 && !values.length ? 0 : total)}</span></div><div class="expense-legend">${values.map((row, index) => `<div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(row[nameKey] || row.method)}</span><strong>${expensePercent(Number(row[valueKey] || 0) / total * 100)}</strong></div>`).join('') || '<div class="empty">暂无本期数据</div>'}</div></div></section>`;
};
let expenseDetailStore = new Map();
const expenseDetailCell = (value, details, title, formatter = expenseMoney) => { if (!details?.length) return formatter(value); const key = `expense-detail-${expenseDetailStore.size + 1}`; expenseDetailStore.set(key, { title, details }); return `<button class="expense-drill" data-expense-detail="${key}" title="点击查看明细">${formatter(value)}</button>`; };
const expenseSectionTable = (section, label) => `<section class="panel expense-section"><div class="toolbar"><div><h2>${escapeHtml(label)}分析</h2><div class="panel-sub">按二级科目归集序时账借方发生额；金额可点击查看明细</div></div><span class="role-badge">本期合计 ${expenseMoney(section.total)}</span></div><div class="table-wrap"><table class="data-table expense-table"><thead><tr><th>二级科目</th><th>本期金额</th><th>上期金额</th><th>变动率</th></tr></thead><tbody>${(section.rows || []).map(row => `<tr><td>${escapeHtml(row.name)}</td><td class="num">${expenseDetailCell(row.current, row.currentDetails, `${label} · ${row.name} · 本期`)}</td><td class="num">${expenseDetailCell(row.prior, row.priorDetails, `${label} · ${row.name} · 上期`)}</td><td class="num ${expenseChangeClass(row.changeRate)}">${row.changeRate === null ? '新增' : `${row.changeRate >= 0 ? '+' : ''}${expensePercent(row.changeRate)}`}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">当前期间暂无费用分录</td></tr>'}</tbody></table></div></section>`;

const openExpenseDetail = key => { const item = expenseDetailStore.get(key); const modal = $('#expense-detail-modal'); if (!item || !modal) return; const rows = item.details || []; modal.querySelector('.expense-detail-modal-title').textContent = item.title; modal.querySelector('.expense-detail-modal-sub').textContent = `共 ${rows.length} 条序时账分录；金额按当前分析口径归集`; modal.querySelector('.expense-detail-modal-body').innerHTML = `<div class="table-wrap"><table class="data-table expense-detail-table"><thead><tr><th>期间</th><th>日期</th><th>凭证号</th><th>摘要</th><th>科目</th><th>借方</th><th>贷方</th><th>归集金额</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.period)}</td><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.voucher)}</td><td class="expense-detail-summary">${escapeHtml(row.summary)}</td><td>${escapeHtml(row.account)}</td><td class="num">${statementAmount(row.debit)}</td><td class="num">${statementAmount(row.credit)}</td><td class="num">${statementAmount(row.amount)}</td></tr>`).join('')}</tbody></table></div>`; modal.classList.remove('hidden'); };
const bindExpenseDetail = () => { document.querySelectorAll('[data-expense-detail]').forEach(button => button.onclick = () => openExpenseDetail(button.dataset.expenseDetail)); $('#expense-detail-close')?.addEventListener('click', () => $('#expense-detail-modal').classList.add('hidden')); $('#expense-detail-modal')?.addEventListener('click', event => { if (event.target.id === 'expense-detail-modal') event.currentTarget.classList.add('hidden'); }); };

const consultantRoiInputDefinitions = [
  { key: 'baseSalary', label: '基本工资' },
  { key: 'commission', label: '提成' },
  { key: 'journalExpense', label: '人员费用' }
];
const consultantRoiColumns = [
  { key: 'name', label: '顾问', type: 'text' }, { key: 'region', label: '业绩归属', type: 'text' },
  { key: 'baseSalary', label: '基本工资', type: 'number' }, { key: 'commission', label: '提成', type: 'number' },
  { key: 'journalExpense', label: '人员费用', type: 'number' }, { key: 'input', label: '投入合计', type: 'number' },
  { key: 'output', label: '预计营收', type: 'number' }, { key: 'roi', label: '投入产出比', type: 'number' },
  { key: 'matchLabel', label: '匹配状态', type: 'status' }
];
const consultantRoiMatchLabel = status => status === 'matched' ? '已匹配' : status === 'missing_payroll' ? '缺工资' : '缺营收';
const consultantRoiSourceText = row => [
  ...(row.payrollDetails || []).map(item => `${item.sourceSheet}第${item.row}行`),
  ...(row.revenueDetails || []).map(item => `${item.sourceSheet}第${item.row}行`),
  ...(row.expenseDetails || []).map(item => `${item.companyName}${item.voucher}${item.account}${item.summary}`)
].join('；');
const consultantRoiNumberFilterMatches = (value, filter) => {
  const text = String(filter || '').trim().replace(/[,，]/g, ''); if (!text) return true;
  const range = text.match(/^(-?\d+(?:\.\d+)?)\s*(?:-|~|～|至)\s*(-?\d+(?:\.\d+)?)$/);
  if (range) return Number(value) >= Math.min(Number(range[1]), Number(range[2])) && Number(value) <= Math.max(Number(range[1]), Number(range[2]));
  const comparison = text.match(/^(>=|<=|>|<|=|≥|≤)\s*(-?\d+(?:\.\d+)?)$/);
  if (comparison) {
    const target = Number(comparison[2]);
    return ({ '>': () => value > target, '>=': () => value >= target, '≥': () => value >= target, '<': () => value < target, '<=': () => value <= target, '≤': () => value <= target, '=': () => value === target }[comparison[1]])();
  }
  const exact = Number(text); return Number.isFinite(exact) ? Number(value) === exact : String(value ?? '').includes(text);
};
const consultantRoiRowsWithSelectedInputs = rawRows => (rawRows || []).map(row => {
    const input = consultantRoiInputDefinitions.reduce((sum, item) => sum + (consultantRoiView.inputs[item.key] ? Number(row[item.key] || 0) : 0), 0);
    const output = Number(row.output || 0); const matchLabel = consultantRoiMatchLabel(row.matchStatus);
    return { ...row, input, output, roi: input ? output / input : null, matchLabel, sourceText: consultantRoiSourceText(row) };
  });
const consultantRoiRowsForView = rawRows => {
  const rows = consultantRoiRowsWithSelectedInputs(rawRows).filter(row => consultantRoiColumns.every(column => {
    const filter = consultantRoiView.filters[column.key]; if (!filter) return true;
    if (column.type === 'number') return consultantRoiNumberFilterMatches(row[column.key], filter);
    return String(row[column.key] ?? '').toLocaleLowerCase('zh-CN').includes(String(filter).toLocaleLowerCase('zh-CN'));
  }));
  const column = consultantRoiColumns.find(item => item.key === consultantRoiView.sortKey) || consultantRoiColumns[6]; const direction = consultantRoiView.sortDirection === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const left = a[column.key]; const right = b[column.key];
    const compared = column.type === 'number' ? (Number(left ?? -Infinity) - Number(right ?? -Infinity)) : String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', { numeric: true });
    return compared * direction || String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
};
const consultantRoiAverageSummary = rawRows => {
  const rows = consultantRoiRowsWithSelectedInputs(rawRows); const valid = rows.filter(row => row.input > 0 && Number.isFinite(row.roi));
  const averageRoi = valid.length ? valid.reduce((sum, row) => sum + row.roi, 0) / valid.length : null; const regions = new Map();
  const ensureRegion = name => { const key = String(name || '待补充').trim() || '待补充'; if (!regions.has(key)) regions.set(key, { region: key, input: 0, output: 0, consultants: new Set() }); return regions.get(key); };
  for (const row of rows) {
    const revenueByRegion = new Map();
    for (const detail of row.revenueDetails || []) { const region = String(detail.region || '待补充').trim() || '待补充'; revenueByRegion.set(region, (revenueByRegion.get(region) || 0) + Number(detail.expectedRevenue || 0)); }
    const attributedOutput = [...revenueByRegion.values()].reduce((sum, value) => sum + value, 0);
    if (attributedOutput > 0) for (const [region, output] of revenueByRegion) { const item = ensureRegion(region); item.output += output; item.input += row.input * output / attributedOutput; item.consultants.add(row.canonicalName || row.name); }
    else { const item = ensureRegion(row.region || '待补充'); item.input += row.input; item.output += row.output; item.consultants.add(row.canonicalName || row.name); }
  }
  return { averageRoi, consultantCount: valid.length, regions: [...regions.values()].map(item => ({ region: item.region, input: item.input, output: item.output, roi: item.input ? item.output / item.input : null, consultantCount: item.consultants.size })).sort((a, b) => b.output - a.output || b.input - a.input) };
};
const consultantRoiFilterHtml = column => column.type === 'status'
  ? `<select data-roi-filter="${column.key}" aria-label="筛选${column.label}"><option value="">全部</option>${['已匹配', '缺工资', '缺营收'].map(value => `<option value="${value}" ${consultantRoiView.filters[column.key] === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`
  : `<input data-roi-filter="${column.key}" value="${escapeHtml(consultantRoiView.filters[column.key] || '')}" aria-label="筛选${column.label}" placeholder="${column.type === 'number' ? '≥、≤、区间' : '筛选'}">`;
const downloadConsultantRoiCsv = (rows, period) => {
  if (!rows.length) return showNotice('当前筛选结果暂无可导出数据', true);
  const selectedInputs = consultantRoiInputDefinitions.filter(item => consultantRoiView.inputs[item.key]); const selected = selectedInputs.map(item => item.label).join('＋') || '未选择投入项';
  const headers = ['顾问', '业绩归属', ...selectedInputs.map(item => item.label), '投入口径', '投入合计', '预计营收', '投入产出比', '匹配状态'];
  const values = rows.map(row => [row.name, row.region, ...selectedInputs.map(item => row[item.key]), selected, row.input, row.output, row.roi == null ? '' : row.roi.toFixed(2), row.matchLabel]);
  const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`; const csv = `\ufeff${[headers, ...values].map(line => line.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${period}-顾问投入产出比.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

async function renderConsultantRoiAnalysis() {
  const page = $('#consultant-roi-analysis-page');
  try {
    const data = await api(`/api/analysis/consultant-roi?company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}`); const rows = data.rows || []; const totals = data.totals || {};
    const sourceState = data.missing?.length ? `<span class="consultant-roi-missing"><strong>来源待补齐</strong><span>${data.missing.map(escapeHtml).join('、')}</span></span>` : '<span class="consultant-roi-complete">三类数据来源已匹配</span>';
    const detail = row => `<details class="consultant-roi-detail"><summary>查看来源</summary><div><strong>工资表</strong>${row.payrollDetails.map(item => `<span>${escapeHtml(item.sourceSheet)} · 第 ${item.row} 行 · 基本工资 ${money(item.baseSalary)} · 提成 ${money(item.commission)}</span>`).join('') || '<span>未匹配</span>'}<strong>预计营收</strong>${row.revenueDetails.map(item => `<span>${escapeHtml(item.sourceSheet)} · 第 ${item.row} 行 · ${escapeHtml(item.region || '待补充')} · ${money(item.expectedRevenue)}</span>`).join('') || '<span>未匹配</span>'}<strong>序时账费用</strong>${row.expenseDetails.map(item => `<span>${escapeHtml(item.companyName)} · ${escapeHtml(item.date)} · ${escapeHtml(item.voucher)} · ${escapeHtml(item.account)} · ${escapeHtml(item.summary)} · ${money(item.amount)}</span>`).join('') || '<span>无明确归属费用</span>'}</div></details>`;
    page.innerHTML = `<div class="page-title"><div><h1>顾问投入产出比</h1><p>${escapeHtml(data.company)} · ${escapeHtml(data.period)} · 按顾问归集</p></div>${filterHtml()}</div><div class="analysis-layout-grid consultant-roi-layout"><section class="panel analysis-source" data-analysis-block="consultant_roi_source"><strong>数据来源</strong><span>工资：${escapeHtml(data.sources.payroll?.fileName || '未上传')} / ${escapeHtml(data.sources.payrollSheet || '—')}；产出：${escapeHtml(data.sources.revenue?.fileName || '未上传')} / ${escapeHtml(data.sources.revenueSheet || '—')}</span><small>投入＝基本工资＋提成＋明确归属于顾问的销售/管理费用；预计营收按签约顾问汇总，地区取业绩归属。${sourceState}</small></section><section class="card-grid consultant-roi-metrics" data-analysis-block="consultant_roi_metrics"><article class="card"><div class="metric-label">投入合计</div><div class="metric-value">${money(totals.input)}</div><div class="metric-note">工资、提成及人员费用</div></article><article class="card"><div class="metric-label">预计营收</div><div class="metric-value positive">${money(totals.output)}</div><div class="metric-note">总营收明细表汇总</div></article><article class="card"><div class="metric-label">整体投入产出比</div><div class="metric-value">${totals.roi == null ? '—' : `${totals.roi.toFixed(2)} 倍`}</div><div class="metric-note">预计营收 ÷ 投入</div></article><article class="card"><div class="metric-label">顾问人数</div><div class="metric-value">${rows.length}</div><div class="metric-note">含待匹配人员</div></article></section><section class="panel consultant-roi-table-panel" data-analysis-block="consultant_roi_table"><div class="toolbar"><div><h2>顾问投入产出明细</h2><div class="panel-sub">按预计营收从高到低排列；“待匹配”不隐藏</div></div></div><div class="table-wrap"><table class="data-table consultant-roi-table"><thead><tr><th>顾问</th><th>业绩归属</th><th>基本工资</th><th>提成</th><th>人员费用</th><th>投入合计</th><th>预计营收</th><th>投入产出比</th><th>匹配状态</th><th>来源</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>${escapeHtml(row.region)}</td><td class="num">${money(row.baseSalary)}</td><td class="num">${money(row.commission)}</td><td class="num">${money(row.journalExpense)}</td><td class="num">${money(row.input)}</td><td class="num">${money(row.output)}</td><td class="num roi-value">${row.roi == null ? '—' : `${row.roi.toFixed(2)} 倍`}</td><td><span class="roi-match ${row.matchStatus}">${row.matchStatus === 'matched' ? '已匹配' : row.matchStatus === 'missing_payroll' ? '缺工资' : '缺营收'}</span></td><td>${detail(row)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">当前期间暂无可匹配的顾问数据</td></tr>'}</tbody></table></div></section></div>`;
    bindCommonFilters(); applyAnalysisBlockLayout(page.querySelector('.consultant-roi-layout'), consultantRoiModuleKey);
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function renderConsultantRoiInteractive({ trigger = 'initial' } = {}) {
  const page = $('#consultant-roi-analysis-page');
  if (consultantRoiRefreshInFlight) return;
  clearConsultantRoiAutoRefresh();
  const scope = { company: state.company, period: state.period }; const revision = ++consultantRoiRequestRevision;
  const isCurrent = () => revision === consultantRoiRequestRevision && state.page === consultantRoiModuleKey && state.company === scope.company && state.period === scope.period;
  const existingTable = page.querySelector('.consultant-roi-table-panel'); const existingButton = $('#consultant-roi-refresh'); const existingStatus = $('#consultant-roi-refresh-status');
  consultantRoiRefreshInFlight = true; page.setAttribute('aria-busy', 'true');
  if (existingButton) { existingButton.disabled = true; existingButton.classList.add('refreshing'); existingButton.innerHTML = '<span aria-hidden="true">↻</span>刷新中…'; }
  if (existingStatus) existingStatus.textContent = trigger === 'auto' ? '正在自动检查最新发布版本…' : '正在读取最新发布版本…';
  try {
    const data = await api(`/api/analysis/consultant-roi?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}`, { cache: 'no-store' });
    if (!isCurrent()) return;
    if (trigger === 'auto' && consultantRoiSourceRevision && data.sourceRevision === consultantRoiSourceRevision && existingTable) return;
    consultantRoiSourceRevision = data.sourceRevision || '';
    const rawRows = data.rows || [];
    const sourceState = data.missing?.length ? `<span class="consultant-roi-missing"><strong>来源待补齐</strong><span>${data.missing.map(escapeHtml).join('、')}</span></span>` : '<span class="consultant-roi-complete">三类数据来源已匹配</span>';
    const payrollFields = data.sources.payrollFields || {}; const salaryFields = Array.isArray(payrollFields.baseSalary) ? payrollFields.baseSalary : [payrollFields.baseSalary].filter(Boolean);
    const payrollFieldText = [payrollFields.company ? `公司→${payrollFields.company}` : '', payrollFields.department ? `部门→${payrollFields.department}` : '', payrollFields.name ? `姓名→${payrollFields.name}` : '', payrollFields.hireDate ? `入职时间→${payrollFields.hireDate}` : '', salaryFields.length ? `基本工资→${salaryFields.join('＋')}` : '', payrollFields.commission ? `提成→${payrollFields.commission}` : ''].filter(Boolean).join('；');
    const revenueFields = data.sources.revenueFields || {}; const revenueFieldText = [revenueFields.period ? `期间→${revenueFields.period}` : '', revenueFields.consultant ? `顾问→${revenueFields.consultant}` : '', revenueFields.region ? `地区→${revenueFields.region}` : '', revenueFields.expectedRevenue ? `预计营收→${revenueFields.expectedRevenue}` : ''].filter(Boolean).join('；');
    const departments = data.sources.payrollConsultantDepartments || []; const departmentText = departments.length ? `顾问部门：${departments.join('、')}，纳入 ${Number(data.sources.payrollConsultantRows || 0)} 人，排除非顾问 ${Number(data.sources.payrollExcludedRows || 0)} 人。` : '';
    const refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const detail = row => `<details class="consultant-roi-detail"><summary>查看来源</summary><div><strong>工资表</strong>${row.payrollDetails.map(item => `<span>${escapeHtml(item.sourceSheet)} · 第 ${item.row} 行 · 基本工资 ${money(item.baseSalary)} · 提成 ${money(item.commission)}</span>`).join('') || '<span>未匹配</span>'}<strong>预计营收</strong>${row.revenueDetails.map(item => `<span>${escapeHtml(item.sourceSheet)} · 第 ${item.row} 行 · ${escapeHtml(item.region || '待补充')} · ${money(item.expectedRevenue)}</span>`).join('') || '<span>未匹配</span>'}<strong>序时账费用</strong>${row.expenseDetails.map(item => `<span>${escapeHtml(item.companyName)} · ${escapeHtml(item.date)} · ${escapeHtml(item.voucher)} · ${escapeHtml(item.account)} · ${escapeHtml(item.summary)} · ${money(item.amount)}</span>`).join('') || '<span>无明确归属费用</span>'}</div></details>`;
    page.innerHTML = `<div class="page-title"><div><h1>顾问投入产出比</h1><p>${escapeHtml(data.company)} · ${escapeHtml(data.period)} · 按顾问部门归集</p></div><div class="consultant-roi-page-actions">${filterHtml()}<div class="consultant-roi-refresh-control"><button class="button consultant-roi-refresh" id="consultant-roi-refresh" type="button"><span aria-hidden="true">↻</span>刷新数据</button><small id="consultant-roi-refresh-status" aria-live="polite">${escapeHtml(refreshedAt)} 已更新 · 每 60 秒自动检查新发布版本</small></div></div></div><div class="analysis-layout-grid consultant-roi-layout"><section class="panel analysis-source" data-analysis-block="consultant_roi_source"><strong>数据来源</strong><span>工资：${escapeHtml(data.sources.payroll?.fileName || '未上传')} / ${escapeHtml(data.sources.payrollSheet || '—')}；产出：${escapeHtml(data.sources.revenue?.fileName || '未上传')} / ${escapeHtml(data.sources.revenueSheet || '—')}</span><small>${payrollFieldText ? `工资取数字段：${escapeHtml(payrollFieldText)}。` : ''}${revenueFieldText ? `营收取数字段：${escapeHtml(revenueFieldText)}，仅取 ${escapeHtml(data.period)}。` : ''}${departmentText ? escapeHtml(departmentText) : ''}${Number(data.sources.unmatchedRevenueRows || 0) ? `另有 ${Number(data.sources.unmatchedRevenueRows)} 条营收明细因人员不在顾问部门名册中未纳入。` : ''}投入标签决定哪些费用计入投入合计和投入产出比；地区只取业绩归属。${sourceState}</small></section><section id="consultant-roi-metrics" class="card-grid consultant-roi-metrics" data-analysis-block="consultant_roi_metrics"></section><section class="panel consultant-roi-table-panel" data-analysis-block="consultant_roi_table"><div class="consultant-roi-table-toolbar"><div><h2>顾问投入产出明细</h2><div class="panel-sub"><span id="consultant-roi-count"></span> · 标签、筛选、排序与导出使用同一当前视图</div></div><div class="consultant-roi-actions"><div class="consultant-roi-tags" role="group" aria-label="选择计入投入合计的数据标签">${consultantRoiInputDefinitions.map(item => `<button type="button" data-roi-input="${item.key}"></button>`).join('')}</div><button type="button" class="button" id="consultant-roi-clear">清除筛选</button><button type="button" class="button primary" id="consultant-roi-export">导出当前视图</button></div></div><div class="table-wrap consultant-roi-table-wrap"><table class="data-table consultant-roi-table"><thead id="consultant-roi-head"></thead><tbody id="consultant-roi-body"></tbody></table></div></section></div>`;
    page.insertAdjacentHTML('beforeend', `<div id="consultant-roi-average-modal" class="consultant-roi-average-modal hidden" role="dialog" aria-modal="true" aria-labelledby="consultant-roi-average-title"><section class="consultant-roi-average-dialog"><button type="button" class="consultant-roi-average-close" aria-label="关闭平均投入产出比">×</button><header><span>AVERAGE ROI</span><h2 id="consultant-roi-average-title">平均投入产出比</h2><p>所有顾问与业绩归属地区</p></header><div id="consultant-roi-average-body"></div></section></div>`);
    const metricCards = document.createElement('div'); metricCards.className = 'consultant-roi-metric-cards'; $('#consultant-roi-metrics').appendChild(metricCards);
    const renderView = () => {
      const rows = consultantRoiRowsForView(rawRows); const totals = rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output }), { input: 0, output: 0 }); const roi = totals.input ? totals.output / totals.input : null; const average = consultantRoiAverageSummary(rawRows);
      const visibleColumns = consultantRoiColumns.filter(column => consultantRoiView.inputs[column.key] !== false);
      metricCards.innerHTML = `<article class="card"><div class="metric-label">投入合计</div><div class="metric-value">${money(totals.input)}</div><div class="metric-note">当前标签与筛选范围</div></article><article class="card"><div class="metric-label">预计营收</div><div class="metric-value positive">${money(totals.output)}</div><div class="metric-note">当前筛选结果汇总</div></article><article class="card"><div class="metric-label">整体投入产出比</div><div class="metric-value">${roi == null ? '—' : `${roi.toFixed(2)} 倍`}</div><div class="metric-note">预计营收 ÷ 已选投入</div></article><button type="button" class="card consultant-roi-average-card" id="consultant-roi-average-open"><div class="metric-label">顾问平均投入产出比</div><div class="metric-value">${average.averageRoi == null ? '—' : `${average.averageRoi.toFixed(2)} 倍`}</div><div class="metric-note">点击查看所有顾问及各地区</div></button><article class="card"><div class="metric-label">顾问人数</div><div class="metric-value">${rows.length}</div><div class="metric-note">工资表顾问部门名册</div></article>`;
      $('#consultant-roi-average-body').innerHTML = `<div class="consultant-roi-average-overall"><span>所有顾问平均投入产出比</span><strong>${average.averageRoi == null ? '—' : `${average.averageRoi.toFixed(2)} 倍`}</strong><small>${average.consultantCount} 名有投入顾问的个人投入产出比算术平均</small></div><div class="consultant-roi-region-list">${average.regions.map(item => `<article><div><strong>${escapeHtml(item.region)}</strong><small>${item.consultantCount} 名顾问</small></div><b>${item.roi == null ? '—' : `${item.roi.toFixed(2)} 倍`}</b><span>投入 ${money(item.input)} · 预计营收 ${money(item.output)}</span></article>`).join('') || '<div class="empty">暂无可汇总的业绩归属地区</div>'}</div><p class="consultant-roi-average-note">跨地区顾问的投入按各地区预计营收占比分摊，避免工资与人员费用被重复计算。</p>`;
      $('#consultant-roi-count').textContent = `共 ${rawRows.length} 人，当前显示 ${rows.length} 人`;
      document.querySelectorAll('[data-roi-input]').forEach(button => { const selected = consultantRoiView.inputs[button.dataset.roiInput]; const label = consultantRoiInputDefinitions.find(item => item.key === button.dataset.roiInput)?.label || ''; button.className = `consultant-roi-tag ${selected ? 'selected' : ''}`; button.setAttribute('aria-pressed', String(selected)); button.innerHTML = `<span>${selected ? '✓' : '+'}</span>${label}`; button.onclick = () => { consultantRoiView.inputs[button.dataset.roiInput] = !selected; if (selected) { delete consultantRoiView.filters[button.dataset.roiInput]; if (consultantRoiView.sortKey === button.dataset.roiInput) { consultantRoiView.sortKey = 'input'; consultantRoiView.sortDirection = 'desc'; } } renderView(); }; });
      $('#consultant-roi-head').innerHTML = `<tr>${visibleColumns.map(column => { const active = consultantRoiView.sortKey === column.key; return `<th><button type="button" class="roi-sort ${active ? 'active' : ''}" data-roi-sort="${column.key}">${column.label}<span>${active ? (consultantRoiView.sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span></button></th>`; }).join('')}</tr><tr class="roi-filter-row">${visibleColumns.map(column => `<th>${consultantRoiFilterHtml(column)}</th>`).join('')}</tr>`;
      const optionalAmountCell = (row, key) => consultantRoiView.inputs[key] ? `<td class="num">${money(row[key])}</td>` : '';
      $('#consultant-roi-body').innerHTML = rows.map((row, index) => `<tr><td><span class="consultant-name-cell"><strong>${escapeHtml(row.name)}</strong>${row.isNewEmployee ? `<button type="button" class="consultant-new-hire-badge" data-consultant-hire="${index}" aria-expanded="false" aria-label="${escapeHtml(row.name)}为本月新员工，查看入职时间">新</button><span class="consultant-hire-popover hidden">入职时间：${escapeHtml(row.hireDate)}</span>` : ''}</span></td><td>${escapeHtml(row.region)}</td>${optionalAmountCell(row, 'baseSalary')}${optionalAmountCell(row, 'commission')}${optionalAmountCell(row, 'journalExpense')}<td class="num">${money(row.input)}</td><td class="num">${money(row.output)}</td><td class="num roi-value">${row.roi == null ? '—' : `${row.roi.toFixed(2)} 倍`}</td><td><span class="roi-match ${row.matchStatus}">${row.matchLabel}</span></td></tr>`).join('') || `<tr><td colspan="${visibleColumns.length}" class="empty">当前标签或筛选条件下暂无顾问数据</td></tr>`;
      document.querySelectorAll('[data-consultant-hire]').forEach(button => button.onclick = event => { event.stopPropagation(); const popover = button.nextElementSibling; const willOpen = popover.classList.contains('hidden'); page.querySelectorAll('.consultant-hire-popover').forEach(item => item.classList.add('hidden')); page.querySelectorAll('[data-consultant-hire]').forEach(item => item.setAttribute('aria-expanded', 'false')); if (willOpen) { popover.classList.remove('hidden'); button.setAttribute('aria-expanded', 'true'); } });
      document.querySelectorAll('[data-roi-sort]').forEach(button => button.onclick = () => { const key = button.dataset.roiSort; if (consultantRoiView.sortKey === key) consultantRoiView.sortDirection = consultantRoiView.sortDirection === 'asc' ? 'desc' : 'asc'; else { consultantRoiView.sortKey = key; consultantRoiView.sortDirection = consultantRoiColumns.find(column => column.key === key)?.type === 'number' ? 'desc' : 'asc'; } renderView(); });
      document.querySelectorAll('[data-roi-filter]').forEach(control => control.onchange = () => { consultantRoiView.filters[control.dataset.roiFilter] = control.value.trim(); renderView(); });
      $('#consultant-roi-clear').onclick = () => { consultantRoiView.filters = {}; renderView(); };
      $('#consultant-roi-export').onclick = () => downloadConsultantRoiCsv(rows, data.period);
      const averageModal = $('#consultant-roi-average-modal'); const closeAverage = () => averageModal.classList.add('hidden'); $('#consultant-roi-average-open').onclick = () => averageModal.classList.remove('hidden'); page.querySelector('.consultant-roi-average-close').onclick = closeAverage; averageModal.onclick = event => { if (event.target === averageModal) closeAverage(); };
    };
    renderView(); bindCommonFilters(); $('#consultant-roi-refresh').onclick = () => renderConsultantRoiInteractive({ trigger: 'manual' }); applyAnalysisBlockLayout(page.querySelector('.consultant-roi-layout'), consultantRoiModuleKey);
  } catch (error) {
    if (!isCurrent()) return;
    if (existingTable) { showNotice(`顾问投入产出数据刷新失败：${error.message}`, true); if (existingStatus) existingStatus.textContent = '刷新失败，稍后将自动重试'; }
    else { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br><button class="button" id="consultant-roi-retry" type="button">重新加载</button></div>`; $('#consultant-roi-retry').onclick = () => renderConsultantRoiInteractive({ trigger: 'manual' }); }
  } finally {
    if (existingButton?.isConnected) { existingButton.disabled = false; existingButton.classList.remove('refreshing'); existingButton.innerHTML = '<span aria-hidden="true">↻</span>刷新数据'; }
    page.removeAttribute('aria-busy'); consultantRoiRefreshInFlight = false; if (state.page === consultantRoiModuleKey) scheduleConsultantRoiAutoRefresh();
  }
}

async function renderIntercompanyReconciliation() {
  const page = $('#intercompany-reconciliation-page');
  try {
    const data = await api(`/api/analysis/intercompany-reconciliation?company=group&period=${encodeURIComponent(state.period)}`); const pairs = data.pairs || []; const companies = data.companies || []; const metrics = data.metrics || {};
    const pairFor = (left, right) => pairs.find(pair => [pair.companyA.key, pair.companyB.key].includes(left) && [pair.companyA.key, pair.companyB.key].includes(right));
    const sourceChips = (data.sources || []).map(source => `<span class="intercompany-source-chip ${source.available ? 'available' : 'missing'}"><i aria-hidden="true">${source.available ? '✓' : '!'}</i><strong>${escapeHtml(source.region)}</strong><small>${source.available ? escapeHtml(source.sourceSheet || '科目余额表') : '未发布'}</small></span>`).join('');
    const scopeWarning = !data.scopeComplete ? `<div class="intercompany-scope-warning"><strong>当前授权范围不足以形成集团完整校验</strong><span>缺少：${escapeHtml((data.missingScopeRegions || []).join('、') || '未登记公司')}；仅展示员工有权访问的公司组合。</span></div>` : '';
    const matrixHead = companies.map(company => `<th title="${escapeHtml(company.name)}">${escapeHtml(company.region)}</th>`).join('');
    const matrixRows = companies.map(rowCompany => `<tr><th title="${escapeHtml(rowCompany.name)}">${escapeHtml(rowCompany.region)}</th>${companies.map(columnCompany => {
      if (rowCompany.key === columnCompany.key) return '<td class="intercompany-diagonal">—</td>';
      const pair = pairFor(rowCompany.key, columnCompany.key); if (!pair) return '<td class="intercompany-empty-cell">暂无</td>';
      const statusClass = intercompanyStatusClass(pair.status.key); return `<td><button type="button" class="intercompany-matrix-cell ${statusClass}" data-intercompany-pair="${escapeHtml(pair.pairKey)}" title="${escapeHtml(pair.companyA.name)} ↔ ${escapeHtml(pair.companyB.name)}：${escapeHtml(pair.status.message)}"><strong>${escapeHtml(pair.status.name)}</strong><small>${intercompanyMoney(pair.absoluteDifference)}</small></button></td>`;
    }).join('')}</tr>`).join('');
    const statusOptions = [...new Map(pairs.map(pair => [pair.status.key, pair.status.name])).entries()].map(([key, name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`).join('');
    const metricCard = (label, value, note, tone = '') => `<article class="card intercompany-metric ${tone}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-note">${escapeHtml(note)}</div></article>`;
    const unmappedRows = (data.unmapped || []).map(row => `<tr><td>${escapeHtml(row.sourceCompanyName)}</td><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.account)}</td><td>${escapeHtml(row.reason)}</td></tr>`).join('');
    page.innerHTML = `<div class="page-title"><div><h1>各公司往来校验</h1><p>${escapeHtml(data.company)} · ${escapeHtml(data.period)} · 七家公司双边期末余额</p></div>${filterHtml()}</div>${scopeWarning}<section class="panel intercompany-completeness"><div class="toolbar"><div><h2>数据完整性</h2><div class="panel-sub">科目余额表用于校验；序时账仅在点击组合后按权限下钻</div></div><span class="intercompany-completeness-state ${data.dataComplete ? 'complete' : 'incomplete'}">${data.dataComplete ? '7 / 7 已齐全' : `${metrics.coveredCompanies || 0} / ${data.expectedCompanyCount || 7} 已齐全`}</span></div><div class="intercompany-source-list">${sourceChips || '<span class="empty">当前授权范围内没有可校验公司</span>'}</div></section><section class="card-grid intercompany-metrics">${metricCard('覆盖公司', `${metrics.coveredCompanies || 0} / ${data.expectedCompanyCount || 7}`, '已发布科目余额表')}${metricCard('公司组合', String(metrics.combinations || 0), '唯一两两组合')}${metricCard('一致组合', String(metrics.matched || 0), `容差 ${Number(data.tolerance || .01).toFixed(2)} 元`, 'matched')}${metricCard('异常组合', String(metrics.exceptions || 0), '包含缺资料与待映射', metrics.exceptions ? 'warning' : '')}${metricCard('绝对差异合计', intercompanyMoney(metrics.absoluteDifference), '已识别净往来差异', metrics.absoluteDifference ? 'warning' : '')}${metricCard('待映射科目', String(metrics.unmappedSubjects || 0), '绝不自动算作一致', metrics.unmappedSubjects ? 'warning' : '')}</section><section class="panel intercompany-matrix-panel"><div class="toolbar"><div><h2>7 × 7 往来校验矩阵</h2><div class="panel-sub">点击任一格查看双方科目余额和序时账；最近状态按组合唯一展示</div></div><div class="intercompany-legend"><span class="matched">一致</span><span class="mismatch">金额差异</span><span class="one-sided">单边</span><span class="unmapped">待映射</span><span class="missing">缺资料</span></div></div><div class="intercompany-matrix-scroll" role="region" aria-label="各公司往来校验矩阵，可左右滑动" tabindex="0"><table class="intercompany-matrix"><thead><tr><th>公司</th>${matrixHead}</tr></thead><tbody>${matrixRows}</tbody></table></div></section><section class="panel intercompany-exception-panel"><div class="toolbar intercompany-table-toolbar"><div><h2>组合校验明细</h2><div class="panel-sub">默认仅看异常，按绝对差异从高到低</div></div><div class="intercompany-filters"><label><input id="intercompany-only-exceptions" type="checkbox" checked> 仅看异常</label><label>状态<select id="intercompany-status-filter"><option value="">全部状态</option>${statusOptions}</select></label></div></div><div class="table-wrap"><table class="data-table intercompany-pair-table"><thead><tr><th>公司组合</th><th>A 方净往来</th><th>B 方净往来</th><th>校验差异</th><th>状态</th><th>说明</th></tr></thead><tbody id="intercompany-pair-body"></tbody></table></div></section>${unmappedRows ? `<section class="panel intercompany-unmapped-panel"><div class="toolbar"><div><h2>待映射科目</h2><div class="panel-sub">名称存在歧义、疑似本公司或业务后缀未确认，均不进入一致结论</div></div><span class="role-badge">${data.unmapped.length} 项</span></div><div class="table-wrap"><table class="data-table intercompany-unmapped-table"><thead><tr><th>账套</th><th>科目编码</th><th>科目名称</th><th>科目类型</th><th>待确认原因</th></tr></thead><tbody>${unmappedRows}</tbody></table></div></section>` : ''}<div id="intercompany-pair-modal" class="intercompany-modal hidden" role="dialog" aria-modal="true" aria-labelledby="intercompany-modal-title"><section class="intercompany-dialog"><button type="button" class="intercompany-modal-close" aria-label="关闭往来明细">×</button><header><h2 id="intercompany-modal-title" class="intercompany-modal-title">往来组合明细</h2><div class="intercompany-modal-sub"></div></header><div class="intercompany-modal-body"></div></section></div>`;
    const renderPairRows = () => {
      const onlyExceptions = $('#intercompany-only-exceptions').checked; const status = $('#intercompany-status-filter').value;
      const visible = pairs.filter(pair => (!onlyExceptions || pair.status.key !== 'matched') && (!status || pair.status.key === status));
      $('#intercompany-pair-body').innerHTML = visible.map(pair => `<tr data-intercompany-pair="${escapeHtml(pair.pairKey)}"><td><button type="button" class="intercompany-pair-link" data-intercompany-pair="${escapeHtml(pair.pairKey)}"><strong>${escapeHtml(pair.companyA.region)} ↔ ${escapeHtml(pair.companyB.region)}</strong><small>查看双方明细</small></button></td><td class="num">${intercompanySignedMoney(pair.sideA.net)}</td><td class="num">${intercompanySignedMoney(pair.sideB.net)}</td><td class="num ${pair.absoluteDifference > Number(data.tolerance || .01) ? 'negative' : 'positive'}">${intercompanySignedMoney(pair.difference)}</td><td><span class="intercompany-status ${intercompanyStatusClass(pair.status.key)}">${escapeHtml(pair.status.name)}</span></td><td>${escapeHtml(pair.status.message)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">当前筛选条件下暂无组合</td></tr>';
      page.querySelectorAll('[data-intercompany-pair]').forEach(button => button.onclick = event => { event.stopPropagation(); const [left, right] = button.dataset.intercompanyPair.split('::'); openIntercompanyPair(left, right); });
    };
    renderPairRows(); $('#intercompany-only-exceptions').onchange = renderPairRows; $('#intercompany-status-filter').onchange = renderPairRows;
    const closeModal = () => $('#intercompany-pair-modal').classList.add('hidden'); page.querySelector('.intercompany-modal-close').onclick = closeModal; $('#intercompany-pair-modal').onclick = event => { if (event.target.id === 'intercompany-pair-modal') closeModal(); };
    bindCommonFilters();
  } catch (error) { page.innerHTML = `<div class="page-title"><div><h1>各公司往来校验</h1><p>${escapeHtml(currentCompanyName())} · ${escapeHtml(state.period)}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}</div>`; bindCommonFilters(); }
}

const intercompanyMoney = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intercompanyStatusClass = key => ({ matched: 'matched', amount_mismatch: 'mismatch', one_sided: 'one-sided', direction_conflict: 'conflict', missing_source: 'missing', unmapped: 'unmapped', direction_abnormal: 'abnormal' }[key] || 'missing');
const intercompanySignedMoney = value => `${Number(value || 0) > 0 ? '+' : ''}${intercompanyMoney(value)}`;
const intercompanyBalanceTable = side => `<div class="table-wrap"><table class="data-table intercompany-balance-table"><thead><tr><th>科目编码</th><th>往来科目</th><th>分类</th><th>期末借方</th><th>期末贷方</th><th>净往来</th></tr></thead><tbody>${(side.rows || []).map(row => `<tr class="${row.directionAbnormal ? 'direction-abnormal-row' : ''}"><td>${escapeHtml(row.code)}</td><td><strong>${escapeHtml(row.account)}</strong><small>${escapeHtml(row.name)}</small></td><td>${escapeHtml(row.categoryName)}</td><td class="num">${intercompanyMoney(row.debit)}</td><td class="num">${intercompanyMoney(row.credit)}</td><td class="num ${Number(row.net) < 0 ? 'negative' : 'positive'}">${intercompanySignedMoney(row.net)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">该方向暂无已识别往来余额</td></tr>'}</tbody></table></div>`;
const intercompanyCategoryTable = pair => `<div class="table-wrap"><table class="data-table intercompany-category-table"><thead><tr><th>业务分类</th><th>${escapeHtml(pair.companyA.name)}对${escapeHtml(pair.companyB.region)}</th><th>${escapeHtml(pair.companyB.name)}对${escapeHtml(pair.companyA.region)}</th><th>校验差异</th></tr></thead><tbody>${(pair.sideA.categories || []).map((item, index) => { const opposite = pair.sideB.categories?.[index] || {}; const difference = Number(item.net || 0) + Number(opposite.net || 0); return `<tr><td>${escapeHtml(item.name)}</td><td class="num">${intercompanySignedMoney(item.net)}</td><td class="num">${intercompanySignedMoney(opposite.net)}</td><td class="num ${Math.abs(difference) > .01 ? 'negative' : 'positive'}">${intercompanySignedMoney(difference)}</td></tr>`; }).join('')}</tbody><tfoot><tr><th>合计</th><th class="num">${intercompanySignedMoney(pair.sideA.net)}</th><th class="num">${intercompanySignedMoney(pair.sideB.net)}</th><th class="num">${intercompanySignedMoney(pair.difference)}</th></tr></tfoot></table></div>`;
const intercompanyJournalTable = journal => {
  if (!journal?.available) return '<div class="empty">该公司本期未发布序时账，无法下钻明细。</div>';
  const note = journal.truncated ? `<div class="standard-hint">共 ${journal.totalRows} 条，仅展示前 500 条。</div>` : '';
  return `${detailTableHtml(journal.rows || [], true)}${note}`;
};

async function openIntercompanyPair(companyA, companyB) {
  const modal = $('#intercompany-pair-modal'); if (!modal) return;
  modal.classList.remove('hidden'); modal.querySelector('.intercompany-modal-body').innerHTML = '<div class="empty">正在读取双方余额与明细…</div>';
  try {
    const data = await api(`/api/analysis/intercompany-reconciliation/pair?company=group&period=${encodeURIComponent(state.period)}&companyA=${encodeURIComponent(companyA)}&companyB=${encodeURIComponent(companyB)}`);
    const pair = data.pair; const statusClass = intercompanyStatusClass(pair.status.key);
    modal.querySelector('.intercompany-modal-title').textContent = `${pair.companyA.name} ↔ ${pair.companyB.name}`;
    modal.querySelector('.intercompany-modal-sub').innerHTML = `<span class="intercompany-status ${statusClass}">${escapeHtml(pair.status.name)}</span><span>${escapeHtml(pair.status.message)}</span>`;
    const sidePanel = side => `<section class="intercompany-side"><header><div><span>${escapeHtml(side.companyName)}</span><strong>对 ${escapeHtml(side.targetCompanyName)} 净往来</strong></div><b class="${Number(side.net) < 0 ? 'negative' : 'positive'}">${intercompanySignedMoney(side.net)}</b></header>${intercompanyBalanceTable(side)}</section>`;
    const journalPanels = data.canViewJournal ? `<section class="intercompany-journal-section"><div class="toolbar"><div><h3>双方序时账明细</h3><div class="panel-sub">只读取上表科目编码；不包含结转分录</div></div></div><div class="intercompany-journal-grid"><article><h4>${escapeHtml(pair.companyA.name)}</h4>${intercompanyJournalTable(data.journals?.[pair.companyA.key])}</article><article><h4>${escapeHtml(pair.companyB.name)}</h4>${intercompanyJournalTable(data.journals?.[pair.companyB.key])}</article></div></section>` : '<section class="intercompany-detail-locked"><strong>余额明细已展示</strong><span>当前员工未同时拥有往来校验明细权限和双方序时账明细权限。</span></section>';
    modal.querySelector('.intercompany-modal-body').innerHTML = `${intercompanyCategoryTable(pair)}<div class="intercompany-side-grid">${sidePanel(pair.sideA)}${sidePanel(pair.sideB)}</div>${journalPanels}`;
  } catch (error) { modal.querySelector('.intercompany-modal-body').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function renderExpenseAnalysis() {
  const page = $('#expense-analysis-page');
  const revision = pageRequestRevision; const scope = { company: state.company, period: state.period };
  try {
    const analysis = await api(`/api/analysis/expenses?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}&year=${encodeURIComponent(scope.period.slice(0, 4))}`);
    if (revision !== pageRequestRevision || state.page !== 'expense_analysis' || state.company !== scope.company || state.period !== scope.period) return;
    if (analysis.finance?.source?.noData || analysis.selling?.source?.noData) { renderMissingData(page, '费用分析', '序时账'); return; }
    expenseDetailStore = new Map();
    const financeRows = analysis.finance?.rows || [];
    const financeTable = `<section class="panel expense-section"><div class="toolbar"><div><h2>财务费用分析</h2><div class="panel-sub">按序时账摘要识别银行存款收入，并匹配同类手续费；金额可点击查看明细</div></div><span class="role-badge">手续费合计 ${expenseMoney(analysis.finance?.feeTotal)}</span></div><div class="table-wrap"><table class="data-table expense-table finance-expense-table"><thead><tr><th>客户支付方式</th><th>本期金额</th><th>上期金额</th><th>变动率</th><th>手续费</th><th>手续费比率</th></tr></thead><tbody>${financeRows.map(row => `<tr><td>${escapeHtml(row.method)}</td><td class="num">${expenseDetailCell(row.current, row.currentDetails, `${row.method} · 本期金额`)}</td><td class="num">${expenseDetailCell(row.prior, row.priorDetails, `${row.method} · 上期金额`)}</td><td class="num ${expenseChangeClass(row.changeRate)}">${row.changeRate === null ? '新增' : `${row.changeRate >= 0 ? '+' : ''}${expensePercent(row.changeRate)}`}</td><td class="num">${expenseDetailCell(row.fee, row.feeDetails, `${row.method} · 本期手续费`)}</td><td class="num">${expenseDetailCell(row.feeRate, row.feeDetails, `${row.method} · 手续费比率`, expenseFeePercent)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">当前期间暂无银行存款收入</td></tr>'}</tbody></table></div></section>`;
    const source = analysis.finance?.source || analysis.selling?.source || {};
    page.innerHTML = `<div class="page-title"><div><h1>费用分析</h1><p>${escapeHtml(analysis.company || currentCompanyName())} · ${escapeHtml(analysis.period)} · 上期 ${escapeHtml(analysis.previousPeriod || '—')}</p></div>${filterHtml()}</div><section class="analysis-source"><strong>数据来源</strong><span>${escapeHtml(source.fileName || '—')} · 序时账${source.demo ? ' · 演示模板，上传后自动切换为发布批次' : ` · 上传批次 ${escapeHtml(source.uploadKey || '—')}`}</span><small>销售费用、管理费用按二级科目归集；财务费用按银行存款收入摘要分类并匹配手续费。</small></section>${expenseSectionTable(analysis.selling, '销售费用')}<div class="two-col expense-chart-grid">${expenseShareChart(analysis.selling?.rows, '销售费用')}${expenseMonthlyChart(analysis.selling?.monthly, '销售费用')}</div>${expenseSectionTable(analysis.administration, '管理费用')}<div class="two-col expense-chart-grid">${expenseShareChart(analysis.administration?.rows, '管理费用')}${expenseMonthlyChart(analysis.administration?.monthly, '管理费用')}</div>${financeTable}<div class="two-col expense-chart-grid">${expenseShareChart(financeRows, '本月支付方式', 'current', 'method')}<section class="panel expense-chart-panel"><div class="toolbar"><div><h3>财务费用月度支付方式</h3><div class="panel-sub">本月支付方式金额对比</div></div></div><div class="bar-chart">${financeRows.map(row => `<div class="bar-row"><div class="bar-label">${escapeHtml(row.method)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, row.current / Math.max(analysis.finance.total, 1) * 100)}%"></div></div><div class="bar-value">${expenseDetailCell(row.current, row.currentDetails, `${row.method} · 本期金额`)}</div></div>`).join('')}</div></section></div><div id="expense-detail-modal" class="expense-detail-modal hidden"><section class="expense-detail-dialog"><button id="expense-detail-close" class="expense-detail-close" aria-label="关闭明细">×</button><h3 class="expense-detail-modal-title">费用明细</h3><div class="expense-detail-modal-sub"></div><div class="expense-detail-modal-body"></div></section></div>`;
    const layout = document.createElement('div'); layout.className = 'analysis-layout-grid'; page.querySelector('.page-title')?.after(layout);
    const sourceBlock = page.querySelector(':scope > .analysis-source'); if (sourceBlock) { sourceBlock.dataset.analysisBlock = 'expense_source'; sourceBlock.classList.add('analysis-span-12'); layout.appendChild(sourceBlock); }
    const tables = [...page.querySelectorAll(':scope > .expense-section')]; const chartGroups = [...page.querySelectorAll(':scope > .expense-chart-grid')];
    const tableKeys = ['selling_table', 'admin_table', 'finance_table']; const chartKeys = [['selling_share', 'selling_trend'], ['admin_share', 'admin_trend'], ['finance_share', 'finance_methods']];
    tables.forEach((table, groupIndex) => {
      table.dataset.analysisBlock = tableKeys[groupIndex]; table.classList.add('analysis-span-12'); layout.appendChild(table);
      [...(chartGroups[groupIndex]?.children || [])].forEach((chart, chartIndex) => { chart.dataset.analysisBlock = chartKeys[groupIndex][chartIndex]; chart.classList.add('analysis-span-6'); layout.appendChild(chart); });
      chartGroups[groupIndex]?.remove();
    });
    applyAnalysisBlockLayout(layout, 'expense_analysis');
    bindCommonFilters(); bindExpenseDetail();
  } catch (error) { if (revision !== pageRequestRevision || state.page !== 'expense_analysis') return; page.innerHTML = `<div class="page-title"><div><h1>费用分析</h1><p>${escapeHtml(currentCompanyName())} · ${state.period}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}</div>`; bindCommonFilters(); }
}

const statementAmount = value => value === null || value === undefined || value === '' ? '' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plainStatementValue = value => typeof value === 'number' && Number.isFinite(value) ? statementAmount(value) : cellText(value);
const statementCell = (value, search = '', detailPeriod = '') => { const text = statementAmount(value); return text && search && canViewCurrentReportDetail() ? `<button class="raw-number statement-number" data-search="${escapeHtml(search)}" ${detailPeriod ? `data-detail-period="${escapeHtml(detailPeriod)}"` : ''} title="点击查看 ${escapeHtml(search)} 明细">${text}</button>` : escapeHtml(text); };
const rawValue = (row, index) => row?.cells?.[index] ?? '';
const cellText = value => String(value ?? '').trim();
const headerIndex = (cells, matcher, start = 0) => cells.findIndex((value, index) => index >= start && matcher.test(cellText(value)));
const trimTrailingEmptyRows = rows => {
  const trimmed = [...(rows || [])];
  const hasVisibleValue = row => (row?.cells || []).some(value => typeof value === 'number' ? Number.isFinite(value) : cellText(value) !== '');
  while (trimmed.length && !hasVisibleValue(trimmed[trimmed.length - 1])) trimmed.pop();
  return trimmed;
};
const rowsThroughLastMatch = (rows, predicate) => {
  let lastMatch = -1;
  (rows || []).forEach((row, index) => { if (predicate(row)) lastMatch = index; });
  return lastMatch >= 0 ? rows.slice(0, lastMatch + 1) : rows;
};
const statementPeriodText = period => {
  const match = String(period || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  return match ? `${match[1]}年${Number(match[2])}月` : String(period || '');
};
const statementMeta = (raw, title, data, companyOverride = '') => {
  const rows = raw.rows || [];
  const metaRow = rows.find(row => (row.cells || []).some(value => /编制单位/.test(cellText(value))))
    || rows.find(row => (row.cells || []).some(value => /^20\d{2}/.test(cellText(value))))
    || { cells: [] };
  const cells = metaRow.cells || [];
  const companyCell = cells.find(value => /编制单位/.test(cellText(value)));
  const company = cellText(companyOverride || companyCell || data.company).replace(/^编制单位\s*[:：]?\s*/, '') || data.company || '';
  const sourceDate = cellText(cells.find(value => /^20\d{2}/.test(cellText(value))) || '');
  const date = statementPeriodText(data.period) || sourceDate;
  const unit = cellText(cells.find(value => /^(?:金额)?单位\s*[:：]/.test(cellText(value))) || '单位：元');
  return `<div class="original-title">${escapeHtml(title)}</div><div class="original-meta"><span>编制单位：${escapeHtml(company)}</span><strong>${escapeHtml(date)}</strong><span>${escapeHtml(unit)}</span></div>`;
};
const reportSourceNote = data => `<div class="original-source">源文件：${escapeHtml(data.meta?.fileName || '—')}　·　工作表：${escapeHtml(data.raw?.sourceSheet || '—')}${data.meta?.demo ? '　·　模板演示，发布后以用户上传批次为准' : `　·　上传批次：${escapeHtml(data.meta?.uploadKey || '')}`}</div>`;
const bindRawNumbers = () => document.querySelectorAll('.raw-number').forEach(button => button.onclick = event => { event.stopPropagation(); openRawDetail(button.dataset.search, button.dataset.detailPeriod); });

function renderBalanceSheet(data) {
  const raw = data.raw || {}; const allRows = trimTrailingEmptyRows(raw.rows || []); const headerRow = allRows.find(row => { const cells = row.cells || []; return cells.some(value => /项目/.test(cellText(value))) && cells.some(value => /负债和所有者权益/.test(cellText(value))); }) || { cells: [] }; const header = headerRow.cells || [];
  const leftNameIndex = headerIndex(header, /项目/); const leftCurrentIndex = headerIndex(header, /期末余额/, leftNameIndex + 1); const leftPriorIndex = headerIndex(header, /年初余额/, leftCurrentIndex + 1); const rightNameIndex = headerIndex(header, /负债和所有者权益/); const rightCurrentIndex = headerIndex(header, /期末余额/, rightNameIndex + 1); const rightPriorIndex = headerIndex(header, /年初余额/, rightCurrentIndex + 1); const rows = allRows.filter(row => row.row > (headerRow.row || 0));
  const body = rows.map(row => { const left = rawValue(row, leftNameIndex); const right = rawValue(row, rightNameIndex); const leftText = cellText(left); const rightText = cellText(right); const total = /合计|资产总计|负债和所有者权益（或股东权益）/.test(`${leftText}${rightText}`); const hasAmount = [leftCurrentIndex, leftPriorIndex, rightCurrentIndex, rightPriorIndex].some(index => typeof rawValue(row, index) === 'number'); const section = !total && !hasAmount && (/：$/.test(leftText) || /：$/.test(rightText)); const klass = `${total ? 'original-total' : ''} ${section ? 'original-section' : ''}`; return `<tr class="${klass}"><td>${escapeHtml(left)}</td><td class="amount">${statementCell(rawValue(row, leftCurrentIndex), leftText)}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, leftPriorIndex)))}</td><td>${escapeHtml(right)}</td><td class="amount">${statementCell(rawValue(row, rightCurrentIndex), rightText)}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, rightPriorIndex)))}</td></tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="original-report"><div class="original-heading asset-liability-analysis-heading">${statementMeta(raw, '资产负债表', data)}${reportSourceNote(data)}${assetLiabilityAnalysisButtonHtml()}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="资产负债表，可左右滑动" tabindex="0"><table class="original-table balance-layout"><colgroup><col class="balance-name"><col class="balance-amount"><col class="balance-amount"><col class="balance-right-name"><col class="balance-amount"><col class="balance-amount"></colgroup><thead><tr><th>${escapeHtml(cellText(rawValue(headerRow, leftNameIndex)) || '项目')}</th><th>${escapeHtml(cellText(rawValue(headerRow, leftCurrentIndex)) || '期末余额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, leftPriorIndex)) || '年初余额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, rightNameIndex)) || '负债和所有者权益（或股东权益）')}</th><th>${escapeHtml(cellText(rawValue(headerRow, rightCurrentIndex)) || '期末余额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, rightPriorIndex)) || '年初余额')}</th></tr></thead><tbody>${body}</tbody></table></div>${canViewCurrentReportDetail() ? '<div class="original-hint">期末余额可点击查看对应明细；年初余额仅作对比展示，不跳转。</div>' : ''}</div><section id="raw-detail-panel" class="panel hidden original-detail"><div class="toolbar"><div><h2 id="raw-detail-heading">关联明细</h2><div id="raw-detail-content"></div></div></div></section>`;
  bindRawNumbers();
  bindAssetLiabilityAnalysis({ api, companyKey: state.company, companyName: data.company || currentCompanyName(), period: data.period || state.period, renderedUploadKey: data.meta?.uploadKey || '' });
}

function renderIncomeStatement(data) {
  const raw = data.raw || {}; const allRows = trimTrailingEmptyRows(raw.rows || []); const headerRow = allRows.find(row => { const cells = row.cells || []; return cells.some(value => /项目/.test(cellText(value))) && cells.some(value => /本期金额/.test(cellText(value))); }) || { cells: [] }; const header = headerRow.cells || []; const nameIndex = headerIndex(header, /项目/); const lineIndex = headerIndex(header, /行次/); const cumulativeIndex = headerIndex(header, /本年累计金额|年度累计/); const currentIndex = headerIndex(header, /本期金额/); const rows = rowsThroughLastMatch(allRows.filter(row => row.row > (headerRow.row || 0)), row => /净利润/.test(cellText(rawValue(row, nameIndex))));
  const body = rows.map(row => { const label = cellText(rawValue(row, nameIndex)); const total = /营业利润|利润总额|净利润/.test(label); return `<tr class="${total ? 'original-total' : ''}"><td>${escapeHtml(label)}</td><td class="line-no">${escapeHtml(rawValue(row, lineIndex))}</td><td class="amount">${statementCell(rawValue(row, cumulativeIndex), label)}</td><td class="amount">${statementCell(rawValue(row, currentIndex), label)}</td></tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="original-report"><div class="original-heading">${statementMeta(raw, '利润表', data)}${reportSourceNote(data)}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="利润表，可左右滑动" tabindex="0"><table class="original-table income-layout"><colgroup><col class="income-name"><col class="income-line"><col class="income-amount"><col class="income-amount"></colgroup><thead><tr><th>${escapeHtml(cellText(rawValue(headerRow, nameIndex)) || '项目')}</th><th>${escapeHtml(cellText(rawValue(headerRow, lineIndex)) || '行次')}</th><th>${escapeHtml(cellText(rawValue(headerRow, cumulativeIndex)) || '本年累计金额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, currentIndex)) || '本期金额')}</th></tr></thead><tbody>${body}</tbody></table></div>${canViewCurrentReportDetail() ? '<div class="original-hint">金额单元格可点击跳转对应明细。</div>' : ''}</div><section id="raw-detail-panel" class="panel hidden original-detail"><div class="toolbar"><div><h2 id="raw-detail-heading">关联明细</h2><div id="raw-detail-content"></div></div></div></section>`;
  bindRawNumbers();
}

function renderConsolidatedIncomeStatement(data) {
  const groupRaw = data.raw || {};
  const selectedEntity = state.consolidatedEntityReportType === 'consolidated_income_statement' && state.consolidatedEntitySheet ? (groupRaw.entities || []).find(entity => entity.sourceSheet === state.consolidatedEntitySheet) : null;
  if (state.consolidatedEntitySheet && !selectedEntity) state.consolidatedEntitySheet = '';
  const raw = selectedEntity || groupRaw; const viewData = selectedEntity ? { ...data, company: selectedEntity.companyName, raw } : data;
  const reportTitle = selectedEntity ? `${selectedEntity.companyName}利润表` : '桉侨集团合并利润表';
  const allRows = raw.rows || []; const headerRow = allRows.find(row => { const cells = row.cells || []; return cells.some(value => /项目/.test(cellText(value))) && cells.some(value => /本期金额/.test(cellText(value))); }) || { cells: [] }; const header = headerRow.cells || []; const nameIndex = headerIndex(header, /项目/); const lineIndex = headerIndex(header, /行次/); const cumulativeIndex = headerIndex(header, /本年累计金额|年度累计/); const currentIndex = headerIndex(header, /本期金额/); const rows = allRows.filter(row => row.row > (headerRow.row || 0));
  const body = rows.map(row => { const label = cellText(rawValue(row, nameIndex)); const total = /营业利润|利润总额|净利润/.test(label); return `<tr class="${total ? 'original-total' : ''}"><td>${escapeHtml(label)}</td><td class="line-no">${escapeHtml(rawValue(row, lineIndex))}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, cumulativeIndex)))}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, currentIndex)))}</td></tr>`; }).join('');
  const entityNames = (groupRaw.entityNames || []).filter(Boolean); const scope = !selectedEntity && entityNames.length ? `<div class="consolidated-scope"><strong>合并范围</strong><span>${entityNames.map(escapeHtml).join('、')}</span><b>${entityNames.length} 家公司 · ${groupRaw.reconciliationPassed === false ? '勾稽待复核' : '勾稽一致'}</b></div>` : '';
  const entityContext = selectedEntity ? `<div class="consolidated-entity-context"><strong>集团子公司分表</strong><span>${escapeHtml(selectedEntity.companyName)}</span><b>来源于当前集团合并文件</b></div>` : '';
  const hint = selectedEntity ? '当前为集团文件内的子公司利润表；金额按源文件保存值展示，不跳转序时账明细。' : '仅展示集团合并利润表正式正文；金额按源文件保存值展示，不跳转序时账明细。';
  $('#report-page').innerHTML = `<div class="original-report consolidated-report"><div class="original-heading">${statementMeta(raw, reportTitle, viewData, selectedEntity?.companyName)}${scope}${entityContext}${reportSourceNote(viewData)}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="${escapeHtml(reportTitle)}，可左右滑动" tabindex="0"><table class="original-table income-layout"><colgroup><col class="income-name"><col class="income-line"><col class="income-amount"><col class="income-amount"></colgroup><thead><tr><th>${escapeHtml(cellText(rawValue(headerRow, nameIndex)) || '项目')}</th><th>${escapeHtml(cellText(rawValue(headerRow, lineIndex)) || '行次')}</th><th>${escapeHtml(cellText(rawValue(headerRow, cumulativeIndex)) || '本年累计金额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, currentIndex)) || '本期金额')}</th></tr></thead><tbody>${body}</tbody></table></div><div class="original-hint">${escapeHtml(hint)}</div></div>`;
}

function renderRevenueProfitConsolidatedStatement(data) {
  const groupRaw = data.raw || {};
  const selectedEntity = state.consolidatedEntityReportType === revenueProfitReportType && state.consolidatedEntitySheet ? (groupRaw.entities || []).find(entity => entity.sourceSheet === state.consolidatedEntitySheet) : null;
  if (state.consolidatedEntityReportType === revenueProfitReportType && state.consolidatedEntitySheet && !selectedEntity) state.consolidatedEntitySheet = '';
  const raw = selectedEntity || groupRaw; const viewData = selectedEntity ? { ...data, company: selectedEntity.companyName, raw } : data;
  const reportTitle = selectedEntity ? `${selectedEntity.companyName}利润表（营收利润口径）` : '（营收利润口径）合并利润表';
  const allRows = raw.rows || [];
  const headerRow = allRows.find(row => { const cells = row.cells || []; return cells.some(value => /项目/.test(cellText(value))) && cells.some(value => /本期金额/.test(cellText(value))); }) || { cells: [] };
  const header = headerRow.cells || [];
  const nameIndex = headerIndex(header, /项目/); const lineIndex = headerIndex(header, /行次/);
  const annualIndex = headerIndex(header, /本年累计金额|年度累计/); const currentIndex = headerIndex(header, /本期金额/);
  const monthlyAdjustmentIndex = headerIndex(header, /当月调整数/); const cumulativeAdjustmentIndex = headerIndex(header, /累计调整数/); const noteIndex = 6;
  const rows = rowsThroughLastMatch(allRows.filter(row => row.row > (headerRow.row || 0)), row => /净利润/.test(cellText(rawValue(row, nameIndex))));
  const body = rows.map(row => {
    const label = cellText(rawValue(row, nameIndex)); const total = /营业利润|利润总额|净利润/.test(label);
    return `<tr class="${total ? 'original-total' : ''}"><td>${escapeHtml(label)}</td><td class="line-no">${escapeHtml(rawValue(row, lineIndex))}</td><td class="amount">${escapeHtml(plainStatementValue(rawValue(row, annualIndex)))}</td><td class="amount">${escapeHtml(plainStatementValue(rawValue(row, currentIndex)))}</td><td class="amount adjustment-cell">${escapeHtml(plainStatementValue(rawValue(row, monthlyAdjustmentIndex)))}</td><td class="amount adjustment-cell">${escapeHtml(plainStatementValue(rawValue(row, cumulativeAdjustmentIndex)))}</td><td class="statement-note">${escapeHtml(cellText(rawValue(row, noteIndex)))}</td></tr>`;
  }).join('');
  const entityNames = (groupRaw.entityNames || []).filter(Boolean);
  const scope = !selectedEntity && entityNames.length ? `<div class="consolidated-scope"><strong>合并范围</strong><span>${entityNames.map(escapeHtml).join('、')}</span><b>${entityNames.length} 家公司 · 营收利润口径</b></div>` : '';
  const entityContext = selectedEntity ? `<div class="consolidated-entity-context"><strong>集团子公司分表</strong><span>${escapeHtml(selectedEntity.companyName)}</span><b>来源于当前营收利润口径集团文件</b></div>` : '';
  const hint = selectedEntity ? '当前为营收利润口径集团文件内的子公司利润表；金额、调整数及说明按源文件保存值展示，不跳转序时账明细。' : '仅展示营收利润口径集团合并利润表 B 至 H 列正式正文；金额及调整数不跳转序时账明细。';
  $('#report-page').innerHTML = `<div class="original-report consolidated-report revenue-profit-report"><div class="original-heading">${statementMeta(raw, reportTitle, viewData, selectedEntity?.companyName)}${scope}${entityContext}${reportSourceNote(viewData)}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="${escapeHtml(reportTitle)}，可左右滑动" tabindex="0"><table class="original-table revenue-profit-layout"><colgroup><col class="revenue-profit-name"><col class="revenue-profit-line"><col class="revenue-profit-amount" span="4"><col class="revenue-profit-note"></colgroup><thead><tr><th>${escapeHtml(cellText(rawValue(headerRow, nameIndex)) || '项目')}</th><th>${escapeHtml(cellText(rawValue(headerRow, lineIndex)) || '行次')}</th><th>${escapeHtml(cellText(rawValue(headerRow, annualIndex)) || '本年累计金额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, currentIndex)) || '本期金额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, monthlyAdjustmentIndex)) || '当月调整数')}</th><th>${escapeHtml(cellText(rawValue(headerRow, cumulativeAdjustmentIndex)) || '累计调整数')}</th><th>${escapeHtml(cellText(rawValue(headerRow, noteIndex)) || '说明')}</th></tr></thead><tbody>${body}</tbody></table></div><div class="original-hint">${escapeHtml(hint)}</div></div>`;
}

function renderCashFlowStatement(data) {
  const raw = data.raw || {}; const allRows = trimTrailingEmptyRows(raw.rows || []); const headerRow = allRows.find(row => { const cells = row.cells || []; return cells.some(value => /项目/.test(cellText(value))) && cells.some(value => /本期金额/.test(cellText(value))); }) || { cells: [] }; const header = headerRow.cells || []; const nameIndex = headerIndex(header, /项目/); const cumulativeIndex = headerIndex(header, /年度累计|本年累计(?:金额)?|\d{4}年累计/); const priorIndex = headerIndex(header, /前期累计金额|上期累计金额/); const currentIndex = headerIndex(header, /本期金额/); const rows = allRows.filter(row => row.row > (headerRow.row || 0)); const titleCell = allRows.slice(0, headerRow.row || 0).flatMap(row => row.cells || []).find(value => /现金流量表/.test(cellText(value))); const cashTitle = cellText(titleCell) || '现金流量表';
  const body = rows.map(row => { const label = cellText(rawValue(row, nameIndex)); const total = /小计|合计|净增加额|余额/.test(label); const section = /^\s*[一二三四五六七八九十]+、/.test(label); return `<tr class="${total ? 'original-total' : ''} ${section ? 'original-section' : ''}"><td>${escapeHtml(label)}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, cumulativeIndex)))}</td><td class="amount">${escapeHtml(statementAmount(rawValue(row, priorIndex)))}</td><td class="amount">${statementCell(rawValue(row, currentIndex), label, state.period)}</td></tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="original-report"><div class="original-heading">${statementMeta(raw, cashTitle, data)}${reportSourceNote(data)}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="现金流量表，可左右滑动" tabindex="0"><table class="original-table cash-layout"><colgroup><col class="cash-name"><col class="cash-amount"><col class="cash-amount"><col class="cash-amount"></colgroup><thead><tr><th>${escapeHtml(cellText(rawValue(headerRow, nameIndex)) || '项目')}</th><th>${escapeHtml(cellText(rawValue(headerRow, cumulativeIndex)) || '年度累计')}</th><th>${escapeHtml(cellText(rawValue(headerRow, priorIndex)) || '前期累计金额')}</th><th>${escapeHtml(cellText(rawValue(headerRow, currentIndex)) || '本期金额')}</th></tr></thead><tbody>${body}</tbody></table></div>${canViewCurrentReportDetail() ? '<div class="original-hint">本期金额可点击查看对应底稿明细；年度累计和前期累计金额仅作对比展示，不跳转。</div>' : ''}</div><section id="raw-detail-panel" class="panel hidden original-detail"><div class="toolbar"><div><h2 id="raw-detail-heading">关联明细</h2><div id="raw-detail-content"></div></div></div></section>`;
  bindRawNumbers();
}

function renderTrialBalance(data) {
  const raw = data.raw || {}; const allRows = trimTrailingEmptyRows(raw.rows || []); const rows = allRows.filter(row => row.row >= 5); const titleRow = allRows.find(row => row.row === 1) || { cells: [] }; const metaRow = allRows.find(row => row.row === 2) || { cells: [] }; const company = String(rawValue(metaRow, 0) || data.company).replace(/^编制单位：\s*/, ''); const range = rawValue(metaRow, 4) || data.period; const totalPattern = /合计|总计/;
  const body = rows.map(row => { const code = String(rawValue(row, 0) || ''); const name = String(rawValue(row, 1) || ''); const total = totalPattern.test(name); const amount = index => statementCell((rawValue(row, index)), name.trim()); return `<tr class="${total ? 'original-total' : ''}"><td class="account-code">${escapeHtml(code)}</td><td class="account-name">${escapeHtml(name)}</td><td class="amount">${amount(2)}</td><td class="amount">${amount(3)}</td><td class="amount">${amount(4)}</td><td class="amount">${amount(5)}</td><td class="amount">${amount(6)}</td><td class="amount">${amount(7)}</td><td class="amount">${amount(8)}</td><td class="amount">${amount(9)}</td></tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="original-report"><div class="original-heading"><div class="original-title">${escapeHtml(rawValue(titleRow, 0) || '科目余额表')}</div><div class="original-meta"><span>编制单位：${escapeHtml(company)}</span><strong>${escapeHtml(range)}</strong><span>${escapeHtml(rawValue(metaRow, 8) || '单位：元')}</span></div>${reportSourceNote(data)}<button class="button primary original-upload" id="go-upload">上传新报表</button></div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="科目余额表，可左右滑动" tabindex="0"><table class="original-table trial-layout"><colgroup><col class="trial-code"><col class="trial-name"><col class="trial-amount" span="8"></colgroup><thead><tr><th rowspan="2">科目编码</th><th rowspan="2">科目名称</th><th colspan="2">期初余额</th><th colspan="2">本期发生额</th><th colspan="2">本年累计发生额</th><th colspan="2">期末余额</th></tr><tr><th>借方</th><th>贷方</th><th>借方</th><th>贷方</th><th>借方</th><th>贷方</th><th>借方</th><th>贷方</th></tr></thead><tbody>${body}</tbody></table></div>${canViewCurrentReportDetail() ? '<div class="original-hint">金额单元格可点击跳转对应明细。</div>' : ''}</div><section id="raw-detail-panel" class="panel hidden original-detail"><div class="toolbar"><div><h2 id="raw-detail-heading">关联明细</h2><div id="raw-detail-content"></div></div></div></section>`;
  bindRawNumbers();
}

function renderJournalStatement(data) {
  const raw = data.raw || {}; const rows = trimTrailingEmptyRows(raw.rows || []).filter(row => row.row > 1); const headers = ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'];
  const body = rows.map(row => { const c = row.cells || []; return `<tr><td>${escapeHtml(c[0])}</td><td>${escapeHtml(c[1])}</td><td class="journal-summary-text">${escapeHtml(c[2])}</td><td>${escapeHtml(c[3])}</td><td class="journal-account-text">${escapeHtml(c[4])}</td><td class="amount">${escapeHtml(statementAmount(c[5]))}</td><td class="amount">${escapeHtml(statementAmount(c[6]))}</td></tr>`; }).join('');
  $('#report-page').innerHTML = `<div class="original-report"><div class="original-heading"><div class="original-title">序时账</div><div class="original-meta"><span>${escapeHtml(data.company || currentCompanyName())}</span><strong>${escapeHtml(data.period || state.period)}</strong><span>单位：元</span></div>${reportSourceNote(data)}</div><div class="original-scroll-cue" aria-hidden="true">← 左右滑动查看完整报表 →</div><div class="original-table-scroll" role="region" aria-label="序时账，可左右滑动" tabindex="0"><table class="original-table journal-layout"><colgroup><col class="journal-date"><col class="journal-voucher"><col class="journal-summary"><col class="journal-code"><col class="journal-account"><col class="journal-amount"><col class="journal-amount"></colgroup><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="7" class="empty">当前期间暂无序时账资料。</td></tr>`}</tbody></table></div><div class="original-hint">序时账仅展示核心字段；摘要和科目名称支持自动换行。</div></div>`;
}

const revenueCellText = (value, header) => {
  if (value === null || value === undefined || String(value).trim() === '') return '—';
  if (/月份/.test(header) && /^20\d{4}$/.test(String(value))) return `${String(value).slice(0, 4)}-${String(value).slice(4)}`;
  if (typeof value !== 'number') return String(value);
  if (/占比/.test(header)) return `${(value * 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (/营收/.test(header)) return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};

async function renderRevenueStatistics() {
  const page = $('#revenue-statistics-page');
  try {
    const uploadQuery = state.uploadKey ? `&uploadKey=${encodeURIComponent(state.uploadKey)}` : '';
    const data = await api(`/api/reports/${revenueStatisticsReportType}/raw?company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}${uploadQuery}`);
    state.uploadKey = null;
    const dimensions = data.raw?.dimensions || [];
    if (!dimensions.length) {
      page.innerHTML = `<div class="page-title"><div><h1>营收统计表</h1><p>集团维度、单独直客维度、单独渠道维度</p></div></div><div class="empty">${escapeHtml(data.meta?.noData ? `${state.period} 暂无已发布营收统计表` : '源文件未识别到三个营收统计维度')}</div>`;
      return;
    }
    if (!dimensions.some(item => item.key === state.revenueDimension)) state.revenueDimension = dimensions[0].key;
    const paint = () => {
      const dimension = dimensions.find(item => item.key === state.revenueDimension) || dimensions[0];
      if (!dimension.tables?.some(item => item.key === state.revenueTable)) state.revenueTable = dimension.tables?.[0]?.key || '';
      const table = dimension.tables?.find(item => item.key === state.revenueTable);
      const dimensionButtons = dimensions.map(item => `<button type="button" class="revenue-dimension-button ${item.key === dimension.key ? 'active' : ''}" data-revenue-page-dimension="${escapeHtml(item.key)}"><small>一级维度</small><strong>${escapeHtml(item.name)}</strong><span>${item.tables?.length || 0} 张子表</span></button>`).join('');
      const tableTabs = (dimension.tables || []).map(item => `<button type="button" class="revenue-table-tab ${item.key === state.revenueTable ? 'active' : ''}" data-revenue-table="${escapeHtml(item.key)}"><b>${escapeHtml(item.key)}</b><span>${escapeHtml(item.shortTitle || item.title)}</span></button>`).join('');
      const headers = table?.headers || [];
      const rows = (table?.rows || []).map((row, index) => `<tr class="${index === 0 ? 'revenue-total-row' : ''}">${headers.map((header, column) => { const value = row.cells?.[column]; const numeric = typeof value === 'number'; return `<td class="${numeric ? 'revenue-number' : ''}">${escapeHtml(revenueCellText(value, header))}</td>`; }).join('')}</tr>`).join('');
      const sourceState = data.meta?.status === 'published' ? '当前发布' : data.meta?.status === 'validated' ? '待发布预览' : data.meta?.status || '原始资料';
      page.innerHTML = `<div class="page-title revenue-page-title"><div><h1>营收统计表</h1><p>${escapeHtml(data.company)} · ${escapeHtml(data.period)} · 三个统计口径独立查看</p></div><div class="revenue-source-badge"><span>${escapeHtml(sourceState)}</span><strong>${escapeHtml(data.meta?.fileName || data.raw?.sourceSheet || '营收统计汇总表')}</strong></div></div><section class="revenue-dimension-switch" aria-label="营收统计一级维度">${dimensionButtons}</section><section class="panel revenue-statistics-panel"><div class="revenue-panel-heading"><div><span>${escapeHtml(dimension.sourceTitle || dimension.name)}</span><h2>${escapeHtml(table?.shortTitle || table?.title || '二级统计表')}</h2></div><div class="revenue-source-meta"><span>${escapeHtml(data.raw?.sourceSheet || '数据统计汇总表（mia）')}</span><b>${escapeHtml(data.raw?.sourcePeriod || data.period)}</b></div></div><div class="revenue-table-tabs" role="tablist" aria-label="${escapeHtml(dimension.name)}二级表">${tableTabs}</div><div class="revenue-table-scroll" role="region" aria-label="${escapeHtml(table?.title || '营收统计表')}，可左右滑动" tabindex="0"><table class="revenue-statistics-table" style="--revenue-columns:${Math.max(headers.length, 1)}"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${Math.max(headers.length, 1)}" class="empty">当前子表暂无数据</td></tr>`}</tbody></table></div>${data.raw?.note ? `<div class="revenue-scope-note"><strong>口径提示</strong><span>${escapeHtml(data.raw.note)}</span></div>` : ''}</section>`;
      page.querySelectorAll('[data-revenue-page-dimension]').forEach(button => button.onclick = () => { state.revenueDimension = button.dataset.revenuePageDimension; state.revenueTable = ''; state.revenueExpanded = true; renderNav(); paint(); applyReportWatermark(); });
      page.querySelectorAll('[data-revenue-table]').forEach(button => button.onclick = () => { state.revenueTable = button.dataset.revenueTable; paint(); applyReportWatermark(); });
    };
    paint();
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function renderUploads() {
  const page = $('#uploads-page');
  const requestRevision = ++uploadHistoryRequestRevision;
  state.uploadCompany ||= state.company;
  state.uploadPeriod ||= state.period;
  state.uploadHistoryView ||= 'pending'; state.uploadHistoryPage ||= 1;
  const historyFilters = state.uploadHistoryFilters || (state.uploadHistoryFilters = { company: state.uploadCompany, period: state.uploadPeriod, reportType: '', search: '' });
  const historyParams = new URLSearchParams({ view: state.uploadHistoryView, page: String(state.uploadHistoryPage), pageSize: '10' });
  Object.entries(historyFilters).forEach(([key, value]) => { if (value) historyParams.set(key, value); });
  let data;
  try {
    data = await api(`/api/uploads?${historyParams}`, { cache: 'no-store' });
    if (requestRevision !== uploadHistoryRequestRevision || state.page !== 'uploads') return;
  } catch (error) {
    if (requestRevision !== uploadHistoryRequestRevision || state.page !== 'uploads') return;
    page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return;
  }
  const uploadTypes = [['bundle', '汇总财务报表（自动识别）'], ['consolidated_income_statement', '桉侨集团合并利润表'], [revenueProfitReportType, '（营收利润口径）合并利润表'], [revenueStatisticsReportType, '集团营收统计表'], [payrollStatementReportType, '集团每月工资表'], ['journal', '序时账'], ['trial_balance', '科目余额表'], ['balance_sheet', '资产负债表'], ['income_statement', '利润表']];
  page.innerHTML = `<div class="page-title"><div><h1>上传报表</h1><p>统一导入入口；支持单独上传，也支持一份汇总财务报表自动拆分</p></div>${filterHtml()}</div><section class="panel"><div class="toolbar"><div><h2>导入报表文件</h2><div class="panel-sub">先选择公司和报表期间；系统会按文件名、工作表名称自动匹配报表类型</div></div></div><div class="upload-target-row"><label>上传公司<select id="upload-company-select">${state.bootstrap.companies.map(item => `<option value="${item.key}" ${item.key === state.company ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>报表期间<select id="upload-period-select">${['2026-05', '2026-06', '2026-07'].map(item => `<option value="${item}" ${item === state.period ? 'selected' : ''}>${item}</option>`).join('')}</select></label></div><div id="folder-drop" class="folder-drop"><input id="folder-picker" type="file" webkitdirectory directory multiple hidden><input id="bundle-picker" type="file" accept=".xlsx,.xls,.json" multiple hidden><div class="folder-icon">↓</div><strong>拖动归集文件夹或汇总财务报表到这里</strong><span>支持从资源管理器拖入文件夹或汇总 Excel；系统按文件名和工作表名称自动识别</span><div class="drop-actions"><button class="button" id="choose-folder">选择归集文件夹</button><button class="button" id="choose-bundle">选择汇总文件</button><button class="button clear-selected-files" id="clear-selected-files" disabled>清空已选</button></div><div id="folder-file-list" class="folder-file-list">尚未选择文件</div></div><div class="upload-slots">${uploadTypes.map(([type, name]) => `<div class="upload-slot" data-upload-slot="${type}" aria-label="将${name}文件拖到这里"><button type="button" class="upload-slot-clear hidden" data-slot-clear="${type}" aria-label="移除${name}" title="移除当前文件">× 移除</button><div class="slot-title">${name}</div><div class="slot-file" id="slot-${type}">未选择文件</div><input class="slot-input" data-report-type="${type}" type="file" accept=".xlsx,.xls,.json"><button type="button" class="button" data-slot-choose="${type}">选择文件</button></div>`).join('')}</div><div class="upload-submit-row"><input id="upload-notes" placeholder="批次备注（可选）"><button class="button primary" id="batch-upload">上传并校验已选择报表</button></div></section><section class="panel" style="margin-top:16px"><div class="toolbar"><div><h2>上传历史</h2><div class="panel-sub">旧批次不会被覆盖；汇总文件会按识别出的每张报表分别保留批次并独立发布</div></div></div><div class="upload-history">${(data.uploads || []).map(item => `<div class="upload-item"><div><strong>${escapeHtml(item.fileName)}</strong><small>${escapeHtml(reportNames[item.reportType] || item.reportType)} · ${item.period} · ${escapeHtml(item.status)} · ${new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><div class="upload-actions">${item.status === 'validated' && state.bootstrap.canPublishReports ? `<button class="button primary" data-publish="${item.uploadKey}">发布为当前版本</button>` : ''}<button class="button" data-preview-upload="${item.uploadKey}" data-preview-type="${item.reportType}">预览</button></div></div>`).join('') || '<div class="empty">暂无上传历史</div>'}</div></section>`;
  bindCommonFilters();
  const uploadStatusNames = { uploaded: '已上传', parsed: '待校验', validated: '已校验', published: '当前发布', superseded: '历史版本', rejected: '校验未通过' };
  const uploadHistory = page.querySelector('.upload-history');
  const uploadHistoryToolbar = uploadHistory?.previousElementSibling;
  const historyRows = data.uploads || []; const deletableUploads = historyRows.filter(item => item.canDelete);
  const historyPeriods = [...new Set([historyFilters.period, ...(data.filterOptions?.periods || [])].filter(Boolean))].sort().reverse();
  const historyReportTypes = [...new Set(data.filterOptions?.reportTypes || [])];
  if (uploadHistoryToolbar) {
    uploadHistoryToolbar.className = 'upload-history-shell';
    uploadHistoryToolbar.innerHTML = `<div class="upload-history-heading"><div><h2>上传记录管理</h2><div class="panel-sub">按公司和月份筛选；待处理发布与已发布版本分开管理</div></div><span class="upload-history-total">筛选范围 ${data.summary?.total || 0} 条</span></div><div class="upload-history-filters"><label><span>公司</span><select id="upload-history-company"><option value="">全部公司</option>${state.bootstrap.companies.map(item => `<option value="${escapeHtml(item.key)}" ${item.key === historyFilters.company ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label><span>月份</span><select id="upload-history-period"><option value="">全部月份</option>${historyPeriods.map(item => `<option value="${escapeHtml(item)}" ${item === historyFilters.period ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label><label><span>报表</span><select id="upload-history-report"><option value="">全部报表</option>${historyReportTypes.map(type => `<option value="${escapeHtml(type)}" ${type === historyFilters.reportType ? 'selected' : ''}>${escapeHtml(reportNames[type] || type)}</option>`).join('')}</select></label><label class="upload-history-search"><span>文件名</span><input id="upload-history-search" value="${escapeHtml(historyFilters.search)}" placeholder="输入后回车"></label><button type="button" class="button upload-history-reset" id="upload-history-reset">重置</button></div><div class="upload-history-tabs" role="tablist" aria-label="上传记录分类"><button type="button" role="tab" data-upload-history-view="pending" aria-selected="${state.uploadHistoryView === 'pending'}" class="${state.uploadHistoryView === 'pending' ? 'active' : ''}"><span>待处理发布</span><b>${data.summary?.pending || 0}</b></button><button type="button" role="tab" data-upload-history-view="versions" aria-selected="${state.uploadHistoryView === 'versions'}" class="${state.uploadHistoryView === 'versions' ? 'active' : ''}"><span>发布版本</span><b>${Number(data.summary?.current || 0) + Number(data.summary?.history || 0)}</b></button></div><div class="upload-history-subhead"><div><strong>${state.uploadHistoryView === 'pending' ? '待处理与待发布' : '当前发布与历史版本'}</strong><small>${state.uploadHistoryView === 'pending' ? '只有已校验记录可批量发布；未发布记录可直接删除' : '当前发布可撤回并恢复上一版本；历史版本锁定保留'}</small></div><div class="upload-history-manage"><label class="upload-select-all"><input id="upload-select-all" type="checkbox" ${deletableUploads.length ? '' : 'disabled'}><span>全选本页可处理</span></label>${state.uploadHistoryView === 'pending' && state.bootstrap.canPublishReports ? '<button type="button" class="button primary batch-publish" id="publish-selected-uploads" disabled><span>发布已选</span> <b id="upload-publish-count">0</b></button>' : ''}<button type="button" class="button danger" id="delete-selected-uploads" disabled><span id="upload-delete-label">${state.uploadHistoryView === 'pending' ? '删除已选' : '撤回当前发布'}</span> <b id="upload-selected-count">0</b></button></div></div>`;
  }
  const historyItemHtml = item => `<div class="upload-item ${item.canDelete ? 'is-selectable' : 'is-locked'} ${item.status === 'published' ? 'is-published' : ''}"><div class="upload-select-slot">${item.canDelete ? `<input class="upload-select-input" type="checkbox" value="${escapeHtml(item.uploadKey)}" data-upload-status="${escapeHtml(item.status)}" data-upload-publishable="${item.status === 'validated' && state.bootstrap.canPublishReports}" aria-label="选择 ${escapeHtml(item.fileName)} ${escapeHtml(reportNames[item.reportType] || item.reportType)}">` : `<span class="upload-history-lock" title="${item.status === 'superseded' ? '历史版本需保留用于追溯' : '当前账号无权处理此记录'}" aria-label="已锁定">◆</span>`}</div><div class="upload-item-info"><strong>${escapeHtml(item.fileName)}</strong><small>${escapeHtml(reportNames[item.reportType] || item.reportType)} · ${escapeHtml(uploadStatusNames[item.status] || item.status)} · ${new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><div class="upload-actions">${item.status === 'validated' && state.bootstrap.canPublishReports ? `<button class="button primary" data-publish="${item.uploadKey}">发布为当前版本</button>` : ''}<button class="button" data-preview-upload="${item.uploadKey}" data-preview-type="${item.reportType}">预览</button></div></div>`;
  const historyGroups = new Map(); historyRows.forEach(item => { const key = `${item.companyKey}::${item.period}`; if (!historyGroups.has(key)) historyGroups.set(key, []); historyGroups.get(key).push(item); });
  const historyGroupsHtml = [...historyGroups.values()].map(items => `<section class="upload-history-group"><header><div><strong>${escapeHtml(companyNameByKey(items[0].companyKey))}</strong><span>${escapeHtml(items[0].period)}</span></div><small>${items.length} 条</small></header><div class="upload-history-group-list">${items.map(historyItemHtml).join('')}</div></section>`).join('');
  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.pageSize || 10)));
  if (uploadHistory) uploadHistory.innerHTML = `${historyGroupsHtml || `<div class="empty">当前筛选条件下暂无${state.uploadHistoryView === 'pending' ? '待处理记录' : '发布版本'}</div>`}<div class="upload-history-pagination"><span>共 ${data.total || 0} 条 · 第 ${data.page || 1} / ${totalPages} 页</span><div><button type="button" class="button" id="upload-history-prev" ${Number(data.page || 1) <= 1 ? 'disabled' : ''}>上一页</button><button type="button" class="button" id="upload-history-next" ${Number(data.page || 1) >= totalPages ? 'disabled' : ''}>下一页</button></div></div>`;
  const refreshUploadHistory = updates => { Object.assign(historyFilters, updates); state.uploadHistoryPage = 1; renderUploads(); };
  $('#upload-history-company').onchange = event => refreshUploadHistory({ company: event.target.value });
  $('#upload-history-period').onchange = event => refreshUploadHistory({ period: event.target.value });
  $('#upload-history-report').onchange = event => refreshUploadHistory({ reportType: event.target.value });
  $('#upload-history-search').onkeydown = event => { if (event.key === 'Enter') refreshUploadHistory({ search: event.target.value.trim() }); };
  $('#upload-history-reset').onclick = () => { state.uploadHistoryFilters = { company: state.uploadCompany, period: state.uploadPeriod, reportType: '', search: '' }; state.uploadHistoryPage = 1; renderUploads(); };
  page.querySelectorAll('[data-upload-history-view]').forEach(button => button.onclick = () => { state.uploadHistoryView = button.dataset.uploadHistoryView; state.uploadHistoryPage = 1; renderUploads(); });
  $('#upload-history-prev').onclick = () => { state.uploadHistoryPage = Math.max(1, Number(data.page || 1) - 1); renderUploads(); };
  $('#upload-history-next').onclick = () => { state.uploadHistoryPage = Math.min(totalPages, Number(data.page || 1) + 1); renderUploads(); };
  page.querySelector('.page-title .filter')?.remove();
  const uploadTargetRow = page.querySelector('.upload-target-row');
  uploadTargetRow.innerHTML = `<div class="upload-scope-field"><span class="upload-scope-label">上传公司</span><div class="upload-picker" id="upload-company-picker"><input id="upload-company-select" type="hidden" value="${escapeHtml(state.uploadCompany)}"><button type="button" class="upload-picker-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="upload-picker-icon">企</span><span><small>目标公司</small><strong id="upload-company-value">${escapeHtml(companyNameByKey(state.uploadCompany))}</strong></span><b aria-hidden="true"></b></button><div class="upload-picker-menu hidden" role="listbox">${state.bootstrap.companies.map((item, index) => `<button type="button" class="upload-picker-option ${item.key === state.uploadCompany ? 'selected' : ''}" data-upload-company="${escapeHtml(item.key)}" role="option" aria-selected="${item.key === state.uploadCompany}"><i class="tone-${index % 3}">${escapeHtml(item.name.slice(0, 2))}</i><span>${escapeHtml(item.name)}</span><em>✓</em></button>`).join('')}</div></div></div><div class="upload-scope-field"><span class="upload-scope-label">报表期间</span><div class="upload-picker" id="upload-period-picker"><input id="upload-period-select" type="hidden" value="${escapeHtml(state.uploadPeriod)}"><button type="button" class="upload-picker-trigger" aria-haspopup="dialog" aria-expanded="false"><span class="upload-picker-icon calendar">月</span><span><small>会计期间</small><strong id="upload-period-value">${escapeHtml(state.uploadPeriod.replace('-', ' 年 '))} 月</strong></span><b aria-hidden="true"></b></button><div class="upload-period-menu hidden"><header><button type="button" id="upload-year-prev" aria-label="上一年">‹</button><strong id="upload-picker-year"></strong><button type="button" id="upload-year-next" aria-label="下一年">›</button></header><div id="upload-month-grid" class="upload-month-grid"></div></div></div></div><div class="upload-scope-hint"><span>独立上传范围</span><small>此处选择不会改变首页及其他报表的查看范围</small></div>`;
  const companyPicker = $('#upload-company-picker'); const periodPicker = $('#upload-period-picker');
  const selected = state.uploadSelectedFiles || (state.uploadSelectedFiles = {});
  const guessType = fileName => { const name = String(fileName).toLowerCase(); if (name.includes('工资表') || name.includes('薪酬明细')) return payrollStatementReportType; if (name.includes('营收统计表') || name.includes('数据统计汇总表')) return revenueStatisticsReportType; if (name.includes('营收利润口径') || name.includes('营收口径')) return revenueProfitReportType; if (name.includes('合并利润表') || name.includes('集团利润表') || name.includes('consolidated income')) return 'consolidated_income_statement'; if (name.includes('财务报表') || name.includes('汇总报表') || name.includes('financial')) return 'bundle'; if (name.includes('序时账') || name.includes('journal')) return 'journal'; if (name.includes('科目余额') || name.includes('account')) return 'trial_balance'; if (name.includes('资产负债')) return 'balance_sheet'; if (name.includes('利润表') || name.includes('income')) return 'income_statement'; return ''; };
  const guessPeriod = fileName => { const match = String(fileName).match(/(20\d{2})[.\-_年]?\s*0?([1-9]|1[0-2])(?:月|[.\-_]|\b)/i); return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}` : ''; };
  const normalizeCompanyText = value => String(value || '').replace(/桉桥/g, '桉侨').replace(/[\s市]/g, '');
  const companyAliases = name => { const full = normalizeCompanyText(name); if (full === '桉侨集团') return [full]; const brandEnd = full.indexOf('桉侨'); const short = brandEnd >= 0 ? full.slice(0, brandEnd + 2) : full.replace(/(?:有限责任公司|有限公司|公司)$/, ''); return [...new Set([full, short].filter(alias => alias.length >= 2))]; };
  const guessCompanies = fileName => { const name = normalizeCompanyText(fileName); return state.bootstrap.companies.filter(company => companyAliases(company.name).some(alias => name.includes(alias))).map(company => company.key); };
  const guessCompany = fileName => { const matches = guessCompanies(fileName); return matches.length === 1 ? matches[0] : ''; };
  if (state.bootstrap.canCreateCompanies) companyPicker.querySelector('.upload-picker-menu').insertAdjacentHTML('beforeend', `<div class="upload-company-create-zone" role="presentation"><button type="button" class="upload-company-add" id="upload-company-add"><span aria-hidden="true">＋</span><strong>新增公司</strong></button><div class="upload-company-create hidden" id="upload-company-create"><label for="upload-new-company-name">公司名称</label><input id="upload-new-company-name" type="text" maxlength="40" placeholder="例如：长沙桉侨"><div><button type="button" class="button" id="upload-company-create-cancel">取消</button><button type="button" class="button primary" id="upload-company-create-save">创建并选中</button></div></div></div>`);
  const closeUploadPickers = () => { [companyPicker, periodPicker].forEach(picker => { picker.querySelector('.upload-picker-menu,.upload-period-menu')?.classList.add('hidden'); picker.querySelector('.upload-picker-trigger')?.setAttribute('aria-expanded', 'false'); }); };
  const setUploadCompany = (value, { confirmed = false } = {}) => { const company = state.bootstrap.companies.find(item => item.key === value); if (!company) return false; const detectedKeys = [...new Set(Object.values(selected).flatMap(file => guessCompanies(file?.webkitRelativePath || file?.name)))]; if (!confirmed && detectedKeys.length && (detectedKeys.length > 1 || detectedKeys[0] !== value)) { const detectedNames = detectedKeys.map(companyNameByKey).join('、'); if (!window.confirm(`已选择文件检测到的地区为“${detectedNames}”，当前准备选择“${company.name}”。\n\n地区不一致可能导致报表归属错误，确定仍选择 ${company.name}？`)) return false; } state.uploadCompany = value; $('#upload-company-select').value = value; $('#upload-company-value').textContent = company.name; companyPicker.querySelectorAll('[data-upload-company]').forEach(option => { const optionSelected = option.dataset.uploadCompany === value; option.classList.toggle('selected', optionSelected); option.setAttribute('aria-selected', String(optionSelected)); }); closeUploadPickers(); showSelectedScope(Object.values(selected)); return true; };
  const setUploadPeriod = (value, { confirmed = false } = {}) => { if (!/^\d{4}-\d{2}$/.test(value)) return false; const detectedPeriods = [...new Set(Object.values(selected).map(file => guessPeriod(file?.webkitRelativePath || file?.name)).filter(Boolean))]; if (!confirmed && detectedPeriods.length && (detectedPeriods.length > 1 || detectedPeriods[0] !== value)) { if (!window.confirm(`已选择文件检测到的期间为“${detectedPeriods.join('、')}”，当前准备选择“${value}”。\n\n期间不一致可能导致报表归属错误，确定仍选择 ${value}？`)) return false; } state.uploadPeriod = value; $('#upload-period-select').value = value; const [year, month] = value.split('-'); $('#upload-period-value').textContent = `${year} 年 ${month} 月`; periodPicker.querySelectorAll('[data-upload-month]').forEach(option => option.classList.toggle('selected', option.dataset.uploadMonth === value)); closeUploadPickers(); showSelectedScope(Object.values(selected)); return true; };
  const renderUploadMonths = year => { state.uploadPickerYear = Number(year); $('#upload-picker-year').textContent = `${state.uploadPickerYear} 年`; $('#upload-month-grid').innerHTML = Array.from({ length: 12 }, (_, index) => { const value = `${state.uploadPickerYear}-${String(index + 1).padStart(2, '0')}`; return `<button type="button" class="${value === state.uploadPeriod ? 'selected' : ''}" data-upload-month="${value}"><span>${String(index + 1).padStart(2, '0')}</span><small>月</small></button>`; }).join(''); periodPicker.querySelectorAll('[data-upload-month]').forEach(option => option.onclick = () => setUploadPeriod(option.dataset.uploadMonth)); };
  renderUploadMonths(Number(state.uploadPeriod.slice(0, 4)) || new Date().getFullYear());
  companyPicker.querySelector('.upload-picker-trigger').onclick = event => { event.stopPropagation(); const menu = companyPicker.querySelector('.upload-picker-menu'); const opening = menu.classList.contains('hidden'); closeUploadPickers(); menu.classList.toggle('hidden', !opening); companyPicker.querySelector('.upload-picker-trigger').setAttribute('aria-expanded', String(opening)); };
  companyPicker.querySelectorAll('[data-upload-company]').forEach(option => option.onclick = () => setUploadCompany(option.dataset.uploadCompany));
  if (state.bootstrap.canCreateCompanies) {
    const addButton = $('#upload-company-add'); const form = $('#upload-company-create'); const nameInput = $('#upload-new-company-name'); const saveButton = $('#upload-company-create-save');
    const closeCreateForm = () => { form.classList.add('hidden'); addButton.classList.remove('hidden'); nameInput.value = ''; };
    addButton.onclick = event => { event.stopPropagation(); addButton.classList.add('hidden'); form.classList.remove('hidden'); nameInput.focus(); };
    $('#upload-company-create-cancel').onclick = event => { event.stopPropagation(); closeCreateForm(); };
    saveButton.onclick = async event => {
      event.stopPropagation(); const name = nameInput.value.trim(); if (name.length < 2) return showNotice('请输入至少 2 个字符的公司名称', true);
      saveButton.disabled = true;
      try {
        const result = await api('/api/admin/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
        state.bootstrap.companies.push(result.company); state.bootstrap.availablePeriodsByCompany[result.company.key] = []; state.uploadCompany = result.company.key;
        showNotice(`已新增“${result.company.name}”，可继续选择期间和报表文件`); await renderUploads();
      } catch (error) { showNotice(error.message, true); saveButton.disabled = false; }
    };
    nameInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); saveButton.click(); } else if (event.key === 'Escape') { event.stopPropagation(); closeCreateForm(); } };
  }
  periodPicker.querySelector('.upload-picker-trigger').onclick = event => { event.stopPropagation(); const menu = periodPicker.querySelector('.upload-period-menu'); const opening = menu.classList.contains('hidden'); closeUploadPickers(); menu.classList.toggle('hidden', !opening); periodPicker.querySelector('.upload-picker-trigger').setAttribute('aria-expanded', String(opening)); };
  $('#upload-year-prev').onclick = event => { event.stopPropagation(); renderUploadMonths(state.uploadPickerYear - 1); }; $('#upload-year-next').onclick = event => { event.stopPropagation(); renderUploadMonths(state.uploadPickerYear + 1); };
  page.onclick = event => { if (!event.target.closest('.upload-picker')) closeUploadPickers(); }; page.onkeydown = event => { if (event.key === 'Escape') closeUploadPickers(); };
  page.querySelectorAll('[data-preview-upload]').forEach(button => { const item = data.uploads.find(upload => upload.uploadKey === button.dataset.previewUpload); if (item) { button.dataset.previewCompany = item.companyKey; button.dataset.previewPeriod = item.period; const meta = button.closest('.upload-item')?.querySelector('small'); if (meta) meta.textContent = `${companyNameByKey(item.companyKey)} · ${meta.textContent}`; } });
  const uploadCheckboxes = [...page.querySelectorAll('.upload-select-input')]; const uploadSelectAll = $('#upload-select-all'); const publishSelectedUploads = $('#publish-selected-uploads'); const deleteSelectedUploads = $('#delete-selected-uploads');
  const startUploadHistoryMutation = () => {
    if (uploadHistoryMutationInFlight) { showNotice('上一项发布或删除操作仍在处理中，请稍候', true); return false; }
    uploadHistoryMutationInFlight = true; page.setAttribute('aria-busy', 'true');
    page.querySelectorAll('[data-publish],#publish-selected-uploads,#delete-selected-uploads').forEach(control => { control.disabled = true; });
    return true;
  };
  const finishUploadHistoryMutation = () => { uploadHistoryMutationInFlight = false; page.removeAttribute('aria-busy'); };
  const updateUploadSelection = () => {
    const checked = uploadCheckboxes.filter(input => input.checked); const publishedCount = checked.filter(input => input.dataset.uploadStatus === 'published').length; $('#upload-selected-count').textContent = String(checked.length); $('#upload-delete-label').textContent = publishedCount ? '撤回并删除已选' : '删除已选'; deleteSelectedUploads.disabled = checked.length === 0; deleteSelectedUploads.classList.toggle('withdraw', publishedCount > 0);
    if (publishSelectedUploads) { const publishableCount = checked.filter(input => input.dataset.uploadPublishable === 'true').length; $('#upload-publish-count').textContent = String(publishableCount); publishSelectedUploads.disabled = !checked.length || publishableCount !== checked.length; publishSelectedUploads.title = checked.length && publishableCount !== checked.length ? '批量发布仅支持已校验且尚未发布的记录' : ''; }
    uploadSelectAll.checked = uploadCheckboxes.length > 0 && checked.length === uploadCheckboxes.length; uploadSelectAll.indeterminate = checked.length > 0 && checked.length < uploadCheckboxes.length;
    uploadCheckboxes.forEach(input => input.closest('.upload-item')?.classList.toggle('selected', input.checked));
  };
  uploadCheckboxes.forEach(input => input.onchange = updateUploadSelection);
  uploadSelectAll.onchange = () => { uploadCheckboxes.forEach(input => { input.checked = uploadSelectAll.checked; }); updateUploadSelection(); };
  if (publishSelectedUploads) publishSelectedUploads.onclick = async () => {
    const checked = uploadCheckboxes.filter(input => input.checked); const uploadKeys = checked.map(input => input.value); if (!uploadKeys.length || checked.some(input => input.dataset.uploadPublishable !== 'true')) return showNotice('批量发布仅支持已校验且尚未发布的记录', true);
    if (!window.confirm(`确定将已选的 ${uploadKeys.length} 条记录批量发布为当前版本吗？\n\n系统会逐条核对公司、期间和报表类型；发布后，同范围原当前版本将保留为历史版本。`)) return;
    if (!startUploadHistoryMutation()) return;
    try { const result = await api('/api/uploads/bulk-publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadKeys }) }); showNotice(`已批量发布 ${result.publishedCount} 个报表批次`); await renderUploads(); } catch (error) { showNotice(error.message, true); updateUploadSelection(); } finally { finishUploadHistoryMutation(); }
  };
  deleteSelectedUploads.onclick = async () => {
    const checked = uploadCheckboxes.filter(input => input.checked); const uploadKeys = checked.map(input => input.value); if (!uploadKeys.length) return; const publishedCount = checked.filter(input => input.dataset.uploadStatus === 'published').length;
    const publishedWarning = publishedCount ? `\n\n其中 ${publishedCount} 条为当前发布：系统会先撤回并删除，再自动恢复上一历史版本；如无历史版本，对应报表将显示暂无数据。` : '';
    if (!window.confirm(`确定处理已选的 ${uploadKeys.length} 条记录吗？${publishedWarning}\n\n删除后无法恢复，请确认公司、期间和报表类型。`)) return;
    if (!startUploadHistoryMutation()) return;
    try { const result = await api('/api/uploads/bulk-delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadKeys }) }); const rollback = result.withdrawnCount ? `，撤回发布 ${result.withdrawnCount} 条${result.restoredCount ? `，恢复历史版本 ${result.restoredCount} 条` : ''}${result.noDataCount ? `，${result.noDataCount} 张报表转为暂无数据` : ''}` : ''; showNotice(`已删除 ${result.deletedCount} 条记录${rollback}`); await renderUploads(); } catch (error) { showNotice(error.message, true); updateUploadSelection(); } finally { finishUploadHistoryMutation(); }
  };
  const selectedScope = files => { const list = [...files].filter(Boolean); return { periods: [...new Set(list.map(file => guessPeriod(file?.webkitRelativePath || file?.name)).filter(Boolean))], companies: [...new Set(list.flatMap(file => guessCompanies(file?.webkitRelativePath || file?.name)))] }; };
  const showSelectedScope = files => { const list = [...files].filter(file => file && file.name); const { periods, companies } = selectedScope(list); const companyMismatch = companies.length > 1 || (companies.length === 1 && companies[0] !== state.uploadCompany); const periodMismatch = periods.length > 1 || (periods.length === 1 && periods[0] !== state.uploadPeriod); const fileList = $('#folder-file-list'); if (fileList) { fileList.classList.toggle('scope-warning', companyMismatch || periodMismatch); fileList.textContent = list.length ? `${list.map(file => `${file.webkitRelativePath || file.name} → ${guessType(file.name) === 'bundle' ? '汇总财务报表（自动识别）' : reportNames[guessType(file.name)] || '未识别'}`).join('　')}　· 检测：${companies.length ? `地区 ${companies.map(companyNameByKey).join('、')}` : '未识别地区'}；${periods.length ? `期间 ${periods.join('、')}` : '未识别期间'}${companyMismatch || periodMismatch ? `（当前选择：${companyNameByKey(state.uploadCompany)} / ${state.uploadPeriod}）` : ''}` : '尚未选择文件'; } return { companyMismatch, periodMismatch, companies, periods }; };
  const syncSelectedFileControls = () => {
    for (const [type] of uploadTypes) { const file = selected[type]; const slot = $(`#slot-${type}`); const clear = page.querySelector(`[data-slot-clear="${type}"]`); if (slot) slot.textContent = file ? (file.webkitRelativePath || file.name) : '未选择文件'; clear?.classList.toggle('hidden', !file); slot?.closest('.upload-slot')?.classList.toggle('has-file', Boolean(file)); }
    $('#clear-selected-files').disabled = Object.keys(selected).length === 0; showSelectedScope(Object.values(selected));
  };
  syncSelectedFileControls();
  const setFile = (type, file) => { if (!type || !file) return; selected[type] = file; syncSelectedFileControls(); const scope = showSelectedScope(Object.values(selected)); if (scope.companyMismatch || scope.periodMismatch) showNotice('文件范围与当前选择不一致，请核对地区和期间后再上传', true); };
  const clearSelectedFile = type => { if (!selected[type]) return; delete selected[type]; const input = page.querySelector(`.slot-input[data-report-type="${type}"]`); if (input) input.value = ''; if (type === 'bundle') $('#bundle-picker').value = ''; $('#folder-picker').value = ''; syncSelectedFileControls(); showNotice('已从待上传列表移除文件'); };
  page.querySelectorAll('[data-slot-clear]').forEach(button => button.onclick = () => clearSelectedFile(button.dataset.slotClear));
  $('#clear-selected-files').onclick = () => { if (!Object.keys(selected).length) return; for (const key of Object.keys(selected)) delete selected[key]; page.querySelectorAll('.slot-input,#folder-picker,#bundle-picker').forEach(input => { input.value = ''; }); syncSelectedFileControls(); showNotice('已清空全部待上传文件'); };
  const handleFiles = files => { const list = [...files].filter(file => file && file.name); list.forEach(file => setFile(guessType(file.webkitRelativePath || file.name), file)); const scope = showSelectedScope(list); if (scope.companies.length > 1 || scope.periods.length > 1) showNotice('所选文件中检测到多个地区或期间，请拆分后分别上传', true); else if (scope.companyMismatch || scope.periodMismatch) showNotice(`检测到文件范围为 ${scope.companies.length ? companyNameByKey(scope.companies[0]) : '未识别地区'} / ${scope.periods[0] || '未识别期间'}，当前选择为 ${companyNameByKey(state.uploadCompany)} / ${state.uploadPeriod}`, true); };
  const readEntry = entry => new Promise((resolve, reject) => { if (entry.isFile) return entry.file(file => resolve([file]), reject); if (!entry.isDirectory) return resolve([]); const reader = entry.createReader(); const entries = []; const readBatch = () => reader.readEntries(batch => { if (!batch.length) return Promise.all(entries.map(readEntry)).then(groups => resolve(groups.flat()), reject); entries.push(...batch); readBatch(); }, reject); readBatch(); });
  const droppedFiles = async dataTransfer => { const items = [...(dataTransfer?.items || [])]; if (!items.length) return [...(dataTransfer?.files || [])]; const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean); if (!entries.length) return items.map(item => item.getAsFile?.()).filter(Boolean); return (await Promise.all(entries.map(readEntry))).flat(); };
  const supportedUploadFile = file => /\.(xlsx|xls|json)$/i.test(String(file?.name || ''));
  page.querySelectorAll('[data-upload-slot]').forEach(slot => {
    const type = slot.dataset.uploadSlot; const clearDragging = () => slot.classList.remove('dragging');
    const allowDrop = event => { event.preventDefault(); event.stopPropagation(); slot.classList.add('dragging'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    slot.ondragenter = allowDrop; slot.ondragover = allowDrop;
    slot.ondragleave = event => { if (!event.relatedTarget || !slot.contains(event.relatedTarget)) clearDragging(); };
    slot.ondrop = async event => {
      event.preventDefault(); event.stopPropagation(); clearDragging();
      const files = (await droppedFiles(event.dataTransfer)).filter(file => file && file.name);
      if (files.length !== 1) return showNotice('每个报表位置一次只能拖入一个文件', true);
      const [file] = files; if (!supportedUploadFile(file)) return showNotice('仅支持 Excel（.xlsx/.xls）或 JSON 文件', true);
      setFile(type, file);
    };
  });
  page.ondragend = () => page.querySelectorAll('.upload-slot.dragging').forEach(slot => slot.classList.remove('dragging'));
  const folderPicker = page.querySelector('#folder-picker'); const bundlePicker = page.querySelector('#bundle-picker');
  page.querySelector('#choose-folder').onclick = () => folderPicker.click(); folderPicker.onchange = event => handleFiles(event.target.files); page.querySelector('#choose-bundle').onclick = () => bundlePicker.click(); bundlePicker.onchange = event => handleFiles(event.target.files);
  const dropZone = page.querySelector('#folder-drop'); dropZone.ondragenter = event => { event.preventDefault(); event.stopPropagation(); dropZone.classList.add('dragging'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }; dropZone.ondragover = event => { event.preventDefault(); event.stopPropagation(); dropZone.classList.add('dragging'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }; dropZone.ondragleave = event => { if (event.target === dropZone) dropZone.classList.remove('dragging'); }; dropZone.ondrop = async event => { event.preventDefault(); event.stopPropagation(); dropZone.classList.remove('dragging'); handleFiles(await droppedFiles(event.dataTransfer)); };
  page.querySelectorAll('[data-slot-choose]').forEach(button => button.onclick = () => button.closest('[data-upload-slot]')?.querySelector('.slot-input')?.click()); page.querySelectorAll('.slot-input').forEach(input => input.onchange = event => setFile(input.dataset.reportType, event.target.files?.[0]));
  const readBase64 = file => new Promise((resolve, reject) => {
    if (!file?.name) return reject(new Error('文件状态已失效，请重新选择文件'));
    if (!Number.isFinite(file.size) || file.size <= 0) return reject(new Error('文件内容为空，请检查原文件后重新选择'));
    const reader = new FileReader();
    reader.onload = () => { const result = String(reader.result || ''); const separator = result.indexOf(','); const content = separator >= 0 ? result.slice(separator + 1) : ''; if (!content) reject(new Error('浏览器未能读取文件内容，请重新选择文件后再试')); else resolve(content); };
    reader.onerror = () => reject(new Error('文件读取失败，请关闭占用该文件的程序后重新选择'));
    reader.onabort = () => reject(new Error('文件读取已中止，请重新选择文件'));
    reader.readAsDataURL(file);
  });
  const uploadButton = page.querySelector('#batch-upload');
  uploadButton.onclick = async () => {
    const entries = Object.entries(selected); if (!entries.length) return showNotice('请先选择归集文件夹、汇总财务报表或至少一个报表文件', true);
    let companyKey = page.querySelector('#upload-company-select')?.value || ''; let period = page.querySelector('#upload-period-select')?.value || '';
    if (!state.bootstrap.companies.some(company => company.key === companyKey)) return showNotice('上传公司未选择或已失效，请重新选择公司', true);
    if (!/^\d{4}-\d{2}$/.test(period)) return showNotice('报表期间未选择或格式无效，请重新选择期间', true);
    state.uploadCompany = companyKey; state.uploadPeriod = period; let success = 0; const trimmedSheets = []; const successfulScopes = []; uploadButton.disabled = true;
    for (const [reportType, file] of entries) {
      try {
        if (!uploadTypes.some(([type]) => type === reportType)) throw new Error('报表位置已失效，请移除文件后重新选择');
        if (!supportedUploadFile(file)) throw new Error('文件格式无效，仅支持 Excel（.xlsx/.xls）或 JSON 文件');
        const contentBase64 = await readBase64(file);
        const submit = () => api('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyKey, period, reportType: reportType === 'bundle' ? '' : reportType, fileName: file.name, fileType: file.type, contentBase64, notes: page.querySelector('#upload-notes')?.value || '' }) });
        let result; let retries = 0;
        while (!result && retries < 3) {
          try { result = await submit(); }
          catch (error) {
            if (error.code === 'COMPANY_MISMATCH' && error.detectedCompanyKey) {
              const switchCompany = window.confirm(`检测到“${file.name}”的地区为 ${error.detectedCompanyName || companyNameByKey(error.detectedCompanyKey)}，与当前选择 ${error.selectedCompanyName || companyNameByKey(companyKey)} 不一致。\n\n确定：切换到检测地区并继续上传\n取消：保留当前地区并停止上传`);
              if (!switchCompany) throw new Error('已停止上传，请核对并重新选择地区');
              companyKey = error.detectedCompanyKey; state.uploadCompany = companyKey; setUploadCompany(companyKey, { confirmed: true }); retries += 1; continue;
            }
            if (error.code === 'PERIOD_MISMATCH' && error.detectedPeriod) {
              const switchPeriod = window.confirm(`检测到“${file.name}”的期间为 ${error.detectedPeriod}，与当前选择 ${error.selectedPeriod || period} 不一致。\n\n确定：切换到 ${error.detectedPeriod} 并继续上传\n取消：保留当前期间并停止上传`);
              if (!switchPeriod) throw new Error('已停止上传，请核对并重新选择会计期间');
              period = error.detectedPeriod; state.uploadPeriod = period; setUploadPeriod(period, { confirmed: true }); retries += 1; continue;
            }
            throw error;
          }
        }
        if (!result) throw new Error('范围校验次数过多，请拆分文件后重试');
        success += result.uploads?.length || 1; successfulScopes.push({ company: companyKey, period }); trimmedSheets.push(...(result.trimmedSheets || []));
      } catch (error) { showNotice(`${reportType === 'bundle' ? '汇总财务报表' : reportNames[reportType]}：${error.message}`, true); }
    }
    uploadButton.disabled = false;
    if (success) {
      for (const key of Object.keys(selected)) delete selected[key];
      const successfulCompanies = [...new Set(successfulScopes.map(item => item.company))]; const successfulPeriods = [...new Set(successfulScopes.map(item => item.period))];
      state.uploadHistoryView = 'pending'; state.uploadHistoryPage = 1;
      state.uploadHistoryFilters = { company: successfulCompanies.length === 1 ? successfulCompanies[0] : '', period: successfulPeriods.length === 1 ? successfulPeriods[0] : '', reportType: '', search: '' };
      showNotice(`已上传并校验 ${success} 个报表批次${trimmedSheets.length ? `；已自动裁剪 ${trimmedSheets.length} 个工作表的尾部空白范围` : ''}`); await renderUploads();
    }
  };
  page.querySelectorAll('[data-publish]').forEach(button => button.onclick = async () => {
    const item = (data.uploads || []).find(upload => upload.uploadKey === button.dataset.publish); if (!item) return showNotice('上传记录不存在，请刷新后重试', true);
    const confirmed = window.confirm(`即将发布为当前版本，请核对：\n\n文件：${item.fileName}\n地区：${companyNameByKey(item.companyKey)}\n期间：${item.period}\n报表：${reportNames[item.reportType] || item.reportType}\n\n发布后将替换同地区、同期间、同报表的当前版本，原版本保留为历史记录。确定发布？`); if (!confirmed || !startUploadHistoryMutation()) return;
    try { await api(`/api/uploads/${button.dataset.publish}/publish`, { method: 'POST' }); showNotice('已发布为当前版本'); await renderUploads(); }
    catch (error) { showNotice(error.message, true); }
    finally { finishUploadHistoryMutation(); }
  });
  page.querySelectorAll('[data-preview-upload]').forEach(button => button.onclick = () => { state.company = button.dataset.previewCompany || state.company; state.period = button.dataset.previewPeriod || state.period; state.periodExplicit = true; state.page = button.dataset.previewType === payrollStatementReportType ? consultantRoiModuleKey : button.dataset.previewType; state.reportType = button.dataset.previewType; state.version = null; state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; state.consolidatedExpanded = false; state.uploadKey = button.dataset.previewUpload; refresh(); });
}

async function renderDatabaseAdmin() {
  const page = $('#database-admin-page');
  const filters = state.databaseFilters || (state.databaseFilters = { company: state.company, period: state.period, reportType: '', status: '', search: '', page: 1 });
  filters.company ||= state.company;
  const params = new URLSearchParams({ company: filters.company, period: filters.period || '', reportType: filters.reportType, status: filters.status, search: filters.search, page: String(filters.page), pageSize: '20' });
  try {
    const [summary, batches] = await Promise.all([api(`/api/admin/report-data/summary?company=${encodeURIComponent(filters.company)}&period=${encodeURIComponent(filters.period || '')}`), api(`/api/admin/report-data/batches?${params}`)]);
    const statusNames = { parsed: '待校验', validated: '已校验', published: '当前发布', superseded: '历史版本', rejected: '已拒绝', archived: '已归档' };
    const rows = batches.items.map(item => `<tr><td><strong>${escapeHtml(item.fileName)}</strong><small class="db-meta">${escapeHtml(item.uploadKey)} · ${escapeHtml(item.contentHash.slice(0, 12))}…</small></td><td>${escapeHtml(item.companyName)}<br>${escapeHtml(item.period)}</td><td>${escapeHtml(item.reportName)}</td><td>${escapeHtml(item.employeeName)}<br><small>${new Date(item.createdAt).toLocaleString('zh-CN')}</small></td><td><span class="db-status status-${escapeHtml(item.status)}">${statusNames[item.status] || escapeHtml(item.status)}</span><small class="db-meta">${item.publishedVersion ? `当前 v${item.publishedVersion}` : item.latestVersion ? `最新 v${item.latestVersion}` : '暂无快照'}</small></td><td><button class="button" data-db-preview="${escapeHtml(item.uploadKey)}" data-db-type="${escapeHtml(item.reportType)}">查看原始资料</button></td></tr>`).join('');
    const stat = (label, value) => `<div class="card"><div class="metric-label">${label}</div><div class="metric-value db-stat-value">${value}</div></div>`;
    const reportOptions = state.bootstrap.reportTypes.map(item => `<option value="${item.key}" ${item.key === filters.reportType ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
    page.innerHTML = `<div class="page-title"><div><h1>数据库管理</h1><p>管理员专用 · 上传批次、解析结果和发布版本总览</p></div></div><section class="panel"><div class="toolbar"><div><h2>报表数据管理</h2><div class="panel-sub">本地预览版提供查询、状态查看和原始资料预览；发布、回滚、归档将在后续阶段接入</div></div><span class="role-badge">仅管理员可见</span></div><div class="db-filter-grid"><label>公司<select id="db-company">${state.bootstrap.companies.map(item => `<option value="${item.key}" ${item.key === filters.company ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>期间<select id="db-period"><option value="">全部期间</option>${['2026-05', '2026-06', '2026-07'].map(item => `<option value="${item}" ${item === filters.period ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label>报表类型<select id="db-report-type"><option value="">全部报表</option>${reportOptions}</select></label><label>状态<select id="db-status"><option value="">全部状态</option>${Object.entries(statusNames).map(([key, name]) => `<option value="${key}" ${key === filters.status ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="db-search">文件名 / 批次号 / 哈希<input id="db-search" value="${escapeHtml(filters.search)}" placeholder="输入关键词后回车"></label></div></section><div class="card-grid db-summary-grid">${stat('筛选范围批次', summary.total)}${stat('当前发布批次', summary.published)}${stat('当前发布版本', summary.currentVersions)}${stat('状态种类', summary.statuses.length)}</div><section class="panel"><div class="toolbar"><div><h2>上传批次</h2><div class="panel-sub">共 ${batches.total} 条 · 第 ${batches.page} / ${Math.max(1, Math.ceil(batches.total / batches.pageSize))} 页</div></div><div class="toolbar-actions"><button class="button" id="db-reset">重置筛选</button><button class="button" id="db-refresh">刷新</button></div></div><div class="table-wrap"><table class="data-table db-table"><thead><tr><th>原始文件</th><th>公司 / 期间</th><th>报表类型</th><th>上传人 / 时间</th><th>状态 / 版本</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">当前筛选条件下暂无上传批次</td></tr>'}</tbody></table></div><div class="db-pagination"><button class="button" id="db-prev" ${batches.page <= 1 ? 'disabled' : ''}>上一页</button><button class="button" id="db-next" ${batches.page * batches.pageSize >= batches.total ? 'disabled' : ''}>下一页</button></div></section>`;
    const refreshWith = changes => { Object.assign(filters, changes); if (!Object.prototype.hasOwnProperty.call(changes, 'page')) filters.page = 1; renderDatabaseAdmin(); };
    $('#db-company').onchange = event => refreshWith({ company: event.target.value }); $('#db-period').onchange = event => refreshWith({ period: event.target.value }); $('#db-report-type').onchange = event => refreshWith({ reportType: event.target.value }); $('#db-status').onchange = event => refreshWith({ status: event.target.value }); $('#db-search').onkeydown = event => { if (event.key === 'Enter') refreshWith({ search: event.target.value }); }; $('#db-reset').onclick = () => { state.databaseFilters = { company: state.company, period: state.period, reportType: '', status: '', search: '', page: 1 }; renderDatabaseAdmin(); }; $('#db-refresh').onclick = () => renderDatabaseAdmin(); $('#db-prev').onclick = () => refreshWith({ page: Math.max(1, batches.page - 1) }); $('#db-next').onclick = () => refreshWith({ page: batches.page + 1 });
    document.querySelectorAll('[data-db-preview]').forEach(button => button.onclick = () => { state.page = button.dataset.dbType; state.reportType = button.dataset.dbType; state.version = null; state.consolidatedEntityReportType = ''; state.consolidatedEntitySheet = ''; state.consolidatedExpanded = false; state.uploadKey = button.dataset.dbPreview; refresh(); });
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

const activityOptionHtml = (items, selected, placeholder) => `<option value="">${placeholder}</option>${items.map(item => `<option value="${escapeHtml(item.key)}" ${item.key === selected ? 'selected' : ''}>${escapeHtml(item.name)}${item.department ? ` · ${escapeHtml(item.department)}` : ''}</option>`).join('')}`;
const activityDateBoundary = (value, end = false) => {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`); if (!Number.isFinite(date.getTime())) return '';
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
};

async function renderActivityLogs() {
  const page = $('#activity-logs-page');
  const filters = state.activityLogFilters || (state.activityLogFilters = { employeeKey: '', logType: '', action: '', moduleKey: '', companyKey: '', period: '', startDate: '', endDate: '', search: '', page: 1 });
  const params = new URLSearchParams({ page: String(filters.page), pageSize: '20' });
  for (const key of ['employeeKey', 'logType', 'action', 'moduleKey', 'companyKey', 'period', 'search']) if (filters[key]) params.set(key, filters[key]);
  const startAt = activityDateBoundary(filters.startDate); const endAt = activityDateBoundary(filters.endDate, true);
  if (startAt) params.set('startAt', startAt); if (endAt) params.set('endAt', endAt);
  try {
    const data = await api(`/api/admin/activity-logs?${params}`); const selected = new Set(); const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const scopeText = item => [item.moduleName, item.companyName, item.period].filter(Boolean).join(' · ') || '系统级';
    page.innerHTML = `<div class="page-title activity-log-title"><div><h1>浏览日志</h1><p>管理员可查询所有员工的页面浏览、数据访问和操作记录</p></div><button class="button" id="activity-refresh">刷新记录</button></div>
      <div class="activity-log-metrics"><article><span>筛选结果</span><strong>${data.stats.total}</strong><small>条日志</small></article><article class="browse"><span>浏览记录</span><strong>${data.stats.browse}</strong><small>页面与数据访问</small></article><article class="operation"><span>操作记录</span><strong>${data.stats.operation}</strong><small>上传、发布与管理</small></article></div>
      <section class="panel activity-log-filter-panel"><div class="activity-log-filters">
        <label><span>人员</span><select id="activity-employee">${activityOptionHtml(data.filters.employees, filters.employeeKey, '全部人员')}</select></label>
        <label><span>类型</span><select id="activity-type"><option value="">全部类型</option><option value="browse" ${filters.logType === 'browse' ? 'selected' : ''}>浏览日志</option><option value="operation" ${filters.logType === 'operation' ? 'selected' : ''}>操作日志</option></select></label>
        <label><span>动作</span><select id="activity-action">${activityOptionHtml(data.filters.actions, filters.action, '全部动作')}</select></label>
        <label><span>模块</span><select id="activity-module">${activityOptionHtml(data.filters.modules, filters.moduleKey, '全部模块')}</select></label>
        <label><span>公司</span><select id="activity-company">${activityOptionHtml(data.filters.companies, filters.companyKey, '全部公司')}</select></label>
        <label><span>期间</span><input id="activity-period" type="month" value="${escapeHtml(filters.period)}"></label>
        <label><span>开始日期</span><input id="activity-start" type="date" value="${escapeHtml(filters.startDate)}"></label>
        <label><span>结束日期</span><input id="activity-end" type="date" value="${escapeHtml(filters.endDate)}"></label>
        <label class="activity-search"><span>关键词</span><input id="activity-search" value="${escapeHtml(filters.search)}" maxlength="100" placeholder="姓名、动作、目标或详情"></label>
      </div><div class="activity-filter-actions"><button class="button primary" id="activity-apply">应用筛选</button><button class="button" id="activity-reset">重置</button></div></section>
      <section class="panel activity-log-list-panel"><div class="toolbar"><div><h2>日志明细</h2><div class="panel-sub">按发生时间倒序；删除后会新增一条管理员删除操作记录</div></div><button class="button danger" id="activity-delete" disabled>删除所选（0）</button></div>
        <div class="table-wrap"><table class="data-table activity-log-table"><thead><tr><th><input id="activity-check-all" type="checkbox" aria-label="全选当前页"></th><th>时间</th><th>人员</th><th>类型 / 动作</th><th>模块 / 范围</th><th>日志详情</th></tr></thead><tbody>${data.items.map(item => `<tr><td><input class="activity-row-check" type="checkbox" value="${item.auditKey}" aria-label="选择日志 ${item.auditKey}"></td><td class="activity-time">${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }))}</td><td><strong>${escapeHtml(item.employeeName)}</strong><small>${escapeHtml(item.department || item.employeeKey)}</small></td><td><span class="activity-type-badge ${item.logType}">${item.logType === 'browse' ? '浏览' : '操作'}</span><strong>${escapeHtml(item.actionName)}</strong></td><td><strong>${escapeHtml(scopeText(item))}</strong><small>${escapeHtml(item.target)}</small></td><td><details><summary>查看详情</summary><dl><div><dt>动作代码</dt><dd>${escapeHtml(item.action)}</dd></div><div><dt>目标</dt><dd>${escapeHtml(item.target || '—')}</dd></div><div><dt>内容</dt><dd>${escapeHtml(item.detail || '—')}</dd></div><div><dt>日志编号</dt><dd>${item.auditKey}</dd></div></dl></details></td></tr>`).join('') || '<tr><td colspan="6" class="empty">当前筛选条件下暂无日志</td></tr>'}</tbody></table></div>
        <div class="activity-pagination"><span>第 ${data.page} / ${totalPages} 页，共 ${data.total} 条</span><div><button class="button" id="activity-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button class="button" id="activity-next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button></div></div></section>`;
    const readFilters = () => ({ employeeKey: $('#activity-employee').value, logType: $('#activity-type').value, action: $('#activity-action').value, moduleKey: $('#activity-module').value, companyKey: $('#activity-company').value, period: $('#activity-period').value, startDate: $('#activity-start').value, endDate: $('#activity-end').value, search: $('#activity-search').value.trim(), page: 1 });
    const refreshSelection = () => { const button = $('#activity-delete'); button.disabled = !selected.size; button.textContent = `删除所选（${selected.size}）`; $('#activity-check-all').checked = Boolean(data.items.length) && selected.size === data.items.length; };
    page.querySelectorAll('.activity-row-check').forEach(input => input.onchange = () => { input.checked ? selected.add(Number(input.value)) : selected.delete(Number(input.value)); refreshSelection(); });
    $('#activity-check-all').onchange = event => { page.querySelectorAll('.activity-row-check').forEach(input => { input.checked = event.target.checked; event.target.checked ? selected.add(Number(input.value)) : selected.delete(Number(input.value)); }); refreshSelection(); };
    $('#activity-apply').onclick = () => { state.activityLogFilters = readFilters(); renderActivityLogs(); };
    $('#activity-search').onkeydown = event => { if (event.key === 'Enter') $('#activity-apply').click(); };
    $('#activity-reset').onclick = () => { state.activityLogFilters = { employeeKey: '', logType: '', action: '', moduleKey: '', companyKey: '', period: '', startDate: '', endDate: '', search: '', page: 1 }; renderActivityLogs(); };
    $('#activity-refresh').onclick = () => renderActivityLogs(); $('#activity-prev').onclick = () => { filters.page -= 1; renderActivityLogs(); }; $('#activity-next').onclick = () => { filters.page += 1; renderActivityLogs(); };
    $('#activity-delete').onclick = async () => { if (!selected.size || !window.confirm(`确定删除所选 ${selected.size} 条日志吗？此操作会另行留痕。`)) return; try { const result = await api('/api/admin/activity-logs', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auditKeys: [...selected] }) }); showNotice(`已删除 ${result.removed} 条日志，删除操作已留痕`); await renderActivityLogs(); } catch (error) { showNotice(error.message, true); } };
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function loadLineDetail(lineCode, lineName) {
  try {
    const query = `company=${encodeURIComponent(state.company)}&period=${encodeURIComponent(state.period)}${state.version ? `&version=${state.version}` : ''}&line=${encodeURIComponent(lineCode)}`;
    const detail = await api(`/api/reports/${state.reportType}/detail?${query}`);
    state.activeLine = lineCode;
    $('#detail-heading').textContent = `报表明细 · ${lineName}`;
    $('#detail-sub').textContent = `${currentCompanyName()} · ${state.period} · 点击报表其他项目可切换明细`;
    $('#detail-content').innerHTML = detailTableHtml(detail.rows || [], detail.showDirection !== false);
    $('#detail-panel').classList.remove('hidden');
    $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showNotice(error.message, true); }
}

function renderReportShell(title, summary, detail, versions) {
  const lines = summary?.lines || []; const detailRows = detail?.rows || []; state.activeLine = null;
  const categories = [...new Set(lines.map(line => line.category))];
  const statementRows = categories.map(category => `<tr class="statement-group"><td colspan="5">${escapeHtml(category)}</td></tr>${lines.filter(line => line.category === category).map(line => { const diff = line.current - line.prior; const rate = line.prior ? diff / Math.abs(line.prior) * 100 : 0; const total = ['净利润', '期末现金余额', '所有者权益', '货币资金'].includes(line.name); return `<tr class="statement-row ${total ? 'statement-total' : ''} ${detail ? 'clickable' : ''}" data-line-code="${escapeHtml(line.code)}" data-line-name="${escapeHtml(line.name)}" title="${detail ? '点击查看对应明细' : ''}"><td class="statement-name">${escapeHtml(line.name)}</td><td class="num">${money(line.current)}</td><td class="num">${money(line.prior)}</td><td class="num">${diff >= 0 ? '+' : ''}${money(diff)}</td><td class="num">${rate.toFixed(1)}%</td></tr>`; }).join('')}`).join('');
  $('#report-page').innerHTML = `<div class="page-title"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary?.company || currentCompanyName())} · ${state.period} · 版本 v${summary?.snapshot?.version || '—'}</p></div>${filterHtml()}</div><section class="panel report-standard"><div class="toolbar"><div><h2>${escapeHtml(title)}（标准格式）</h2><div class="panel-sub">单位：元　·　来源：${escapeHtml(summary?.snapshot?.source || '—')}　·　${escapeHtml(summary?.snapshot?.status === 'published' ? '已发布' : '未发布')}</div></div><div class="toolbar-actions"><button class="button" id="detail-button" ${detail ? '' : 'disabled'}>查看全部明细</button><button class="button" id="export-summary">导出报表</button></div></div><div class="table-wrap"><table class="data-table statement-table"><thead><tr><th>项目</th><th>本期金额</th><th>上期金额</th><th>变动额</th><th>变动率</th></tr></thead><tbody>${statementRows || '<tr><td colspan="5" class="empty">当前员工没有该报表汇总权限。</td></tr>'}</tbody></table></div>${detail ? '<div class="standard-hint">点击任意报表项目行或下方图表数据，可跳转到对应明细。</div>' : ''}</section><section class="panel" style="margin-top:16px"><h2>项目金额对比</h2><div class="panel-sub">图表仅作为标准报表的辅助视图</div><div class="bar-chart">${lines.map(line => { const max = Math.max(...lines.map(item => Math.abs(item.current)), 1); return `<div class="bar-row drilldown-row ${detail ? 'clickable' : ''}" data-line-code="${escapeHtml(line.code)}" data-line-name="${escapeHtml(line.name)}" title="${detail ? '点击查看对应明细' : ''}"><div class="bar-label">${escapeHtml(line.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, Math.abs(line.current) / max * 100)}%"></div></div><div class="bar-value">¥${money(line.current)}</div></div>`; }).join('')}</div></section><section id="detail-panel" class="panel hidden" style="margin-top:16px"><div class="toolbar"><div><h2 id="detail-heading">报表明细</h2><div id="detail-sub" class="panel-sub">当前版本的科目/序时账明细</div></div><button class="button" id="export-detail">导出明细</button></div><div id="detail-content">${detailTableHtml(detailRows, detail?.showDirection !== false)}</div></section>`;
  bindCommonFilters();
  const versionSelect = $('#version-select'); if (versionSelect) versionSelect.innerHTML = versions.map(item => `<option value="${item.version === summary?.snapshot?.version ? 'current' : item.version}" ${item.version === summary?.snapshot?.version ? 'selected' : ''}>v${item.version} · ${item.status === 'published' ? '已发布' : item.status}</option>`).join('');
  $('#detail-button').onclick = () => { state.activeLine = null; $('#detail-heading').textContent = '报表明细 · 全部项目'; $('#detail-panel').classList.remove('hidden'); };
  document.querySelectorAll('.statement-row.clickable,.drilldown-row.clickable').forEach(row => row.onclick = () => loadLineDetail(row.dataset.lineCode, row.dataset.lineName));
  $('#export-summary').onclick = () => download(`/api/reports/${state.reportType}/export?level=summary&company=${state.company}&period=${state.period}&version=${summary.snapshot.version}`, '财务报表.csv');
  $('#export-detail').onclick = () => download(`/api/reports/${state.reportType}/export?level=detail&company=${state.company}&period=${state.period}&version=${summary.snapshot.version}${state.activeLine ? `&line=${encodeURIComponent(state.activeLine)}` : ''}`, '报表明细.csv');
}

async function download(url, filename) {
  const headers = state.bootstrap?.authMode === 'demo' ? { 'x-demo-employee': state.employeeKey } : {};
  try {
    let response = await fetch(appUrl(url), { headers });
    if (response.status === 401 && state.bootstrap?.authMode === 'platform') { await ensurePlatformSession(); response = await fetch(appUrl(url), { headers }); }
    if (!response.ok) throw new Error('没有导出权限');
    const blob = await response.blob(); const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = filename; anchor.click(); URL.revokeObjectURL(anchor.href);
  } catch (error) { showNotice(error.message, true); }
}

async function refreshReport() {
  const requestRevision = ++reportRequestRevision;
  const scope = { reportType: state.reportType, company: state.company, period: state.period, version: state.version, uploadKey: state.uploadKey || '' };
  const isCurrent = () => requestRevision === reportRequestRevision && state.page === scope.reportType && state.reportType === scope.reportType && state.company === scope.company && state.period === scope.period && state.version === scope.version && (state.uploadKey || '') === scope.uploadKey;
  try {
    if (scope.uploadKey) { const rawData = await api(`/api/reports/${scope.reportType}/raw?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}&uploadKey=${encodeURIComponent(scope.uploadKey)}`); if (!isCurrent()) return; state.uploadKey = null; renderRawReport(rawData); return; }
    const rawData = await api(`/api/reports/${scope.reportType}/raw?company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}`);
    if (!isCurrent()) return;
    renderRawReport(rawData); return;
    /* 标准化汇总接口保留给分析和导出使用。 */
    const query = `company=${encodeURIComponent(scope.company)}&period=${encodeURIComponent(scope.period)}${scope.version ? `&version=${scope.version}` : ''}`;
    const summary = await api(`/api/reports/${scope.reportType}/summary?${query}`);
    if (!isCurrent()) return;
    let detail = null;
    try { detail = await api(`/api/reports/${scope.reportType}/detail?${query}`); if (!isCurrent()) return; } catch (error) { if (!isCurrent()) return; if (!error.message.includes('没有')) showNotice(error.message, true); }
    const versions = await api(`/api/reports/${scope.reportType}/versions?${query}`).catch(() => ({ versions: [] }));
    if (!isCurrent()) return;
    state.summary = summary;
    renderReportShell(reportNames[scope.reportType], summary, detail, versions.versions || []);
  } catch (error) { if (!isCurrent()) return; $('#report-page').innerHTML = `<div class="page-title"><div><h1>${escapeHtml(reportNames[scope.reportType])}</h1><p>${escapeHtml(currentCompanyName())} · ${scope.period}</p></div>${filterHtml()}</div><div class="empty">${escapeHtml(error.message)}<br><button class="button" style="margin-top:12px" id="retry-report">重试</button></div>`; bindCommonFilters(); $('#retry-report').onclick = refreshReport; }
}

async function renderLegacyPermissions() {
  const page = $('#permissions-page');
  try {
    const data = await api('/api/admin/roles');
    const typeKeys = ['balance_sheet', 'income_statement', 'cash_flow'];
    const rows = data.roles.map(role => {
      const people = data.assignments.filter(item => item.roleKey === role.key).map(item => item.employeeName).join('、') || '未分配';
      const cells = typeKeys.map(type => {
        const scopes = data.scopes.filter(item => item.roleKey === role.key && item.reportType === type);
        const summary = scopes.filter(item => item.level === 'summary').map(item => item.action === 'export' ? '汇总·导出' : '汇总·查看');
        const detail = scopes.filter(item => item.level === 'detail').map(item => item.action === 'export' ? '明细·导出' : '明细·查看');
        const labels = [...new Set([...summary, ...detail])];
        return `<div class="permission-cell"><strong>${labels.length ? labels.map(label => `<span>${label}</span>`).join('') : '<span class="muted">无权限</span>'}</strong><small>${scopes.length ? [...new Set(scopes.map(item => companyNameByKey(item.companyKey)))].join('、') : '—'}</small></div>`;
      }).join('');
      return `<div>${escapeHtml(role.name)}<small>${escapeHtml(role.description)}</small></div>${cells}`;
    }).join('');
    const assignments = data.assignments.map(item => `<div class="identity-row"><div><strong>${escapeHtml(item.employeeName)}</strong><small>${escapeHtml(item.roleName)}</small></div><span class="pill">已授权</span></div>`).join('');
    const visibility = roleKey => data.accountVisibility?.find(item => item.roleKey === roleKey)?.visibility || 'level1';
    const directionVisibility = roleKey => data.detailPreferences?.find(item => item.roleKey === roleKey)?.showDirection !== false;
    const fullEntryVisibility = roleKey => data.detailPreferences?.find(item => item.roleKey === roleKey)?.showFullEntry !== false;
    const visibilityPanel = `<section class="panel" style="margin-top:16px"><div class="toolbar"><div><h2>明细显示设置</h2><div class="panel-sub">按角色设置科目名称级别、借贷方向，以及跳转明细时是否展开同一凭证的完整分录</div></div></div><div class="identity-list">${data.roles.map(role => `<div class="identity-row detail-setting-row"><div><strong>${escapeHtml(role.name)}</strong><small>科目名称</small></div><select class="account-visibility-select" data-role-key="${escapeHtml(role.key)}"><option value="level1" ${visibility(role.key) === 'level1' ? 'selected' : ''}>一级科目</option><option value="full" ${visibility(role.key) === 'full' ? 'selected' : ''}>完整科目</option></select><div class="setting-divider"></div><div><small>借贷方向</small></div><select class="detail-direction-select" data-role-key="${escapeHtml(role.key)}"><option value="1" ${directionVisibility(role.key) ? 'selected' : ''}>显示</option><option value="0" ${directionVisibility(role.key) ? '' : 'selected'}>隐藏</option></select><div class="setting-divider"></div><div><small>完整分录</small></div><select class="detail-full-entry-select" data-role-key="${escapeHtml(role.key)}"><option value="1" ${fullEntryVisibility(role.key) ? 'selected' : ''}>展示</option><option value="0" ${fullEntryVisibility(role.key) ? '' : 'selected'}>隐藏</option></select></div>`).join('')}</div></section>`;
    const employeeOptions = state.bootstrap.employees.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)} · ${escapeHtml(item.department)}</option>`).join('');
    const copyPanel = `<section class="panel" style="margin-top:16px"><div class="toolbar"><div><h2>复制员工授权</h2><div class="panel-sub">复制源员工的全部角色权限范围到目标员工，仅替换被授权人；目标员工原有角色将被覆盖</div></div></div><div class="copy-permission-form"><label>复制源员工<select id="copy-source-employee">${employeeOptions}</select></label><span class="copy-arrow">→</span><label>目标员工<select id="copy-target-employee">${employeeOptions}</select></label><button class="button primary" id="copy-permissions-button">复制权限</button></div></section>`;
    page.innerHTML = `<div class="page-title"><div><h1>权限管理</h1><p>直接选择企微通讯录员工，再按报表汇总/明细分别授权</p></div></div><section class="panel"><div class="toolbar"><div><h2>角色权限矩阵</h2><div class="panel-sub">报表类型、汇总/明细层级、公司范围和导出动作独立计算</div></div></div><div class="permission-grid"><div class="head">角色</div>${typeKeys.map(type => `<div class="head">${reportNames[type]}</div>`).join('')}${rows}</div></section>${visibilityPanel}${copyPanel}<section class="two-col"><section class="panel"><h2>当前员工授权</h2><div class="panel-sub">演示环境中由企业微信通讯录同步的员工</div><div class="identity-list">${assignments}</div></section><section class="panel"><h2>新增角色授权</h2><div class="panel-sub">生产环境此处接入企微通讯录搜索</div><label style="display:block;color:#6d7d91;font-size:13px;margin:12px 0 6px">员工<select id="assign-employee" style="display:block;width:100%;margin-top:6px"></select></label><label style="display:block;color:#6d7d91;font-size:13px;margin:12px 0 6px">角色<select id="assign-role" style="display:block;width:100%;margin-top:6px"></select></label><button class="button primary" id="assign-button" style="margin-top:8px">保存授权</button></section></section>`;
    $('#assign-employee').innerHTML = data.assignments.length ? state.bootstrap.employees.map(item => `<option value="${item.key}">${escapeHtml(item.name)} · ${escapeHtml(item.department)}</option>`).join('') : '';
    $('#assign-role').innerHTML = data.roles.map(role => `<option value="${role.key}">${escapeHtml(role.name)}</option>`).join('');
    $('#assign-button').onclick = async () => { try { await api('/api/admin/assign-role', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeKey: $('#assign-employee').value, roleKey: $('#assign-role').value }) }); showNotice('授权已保存'); await renderPermissions(); } catch (error) { showNotice(error.message, true); } };
    $('#copy-target-employee').value = state.bootstrap.employees.find(item => item.key !== $('#copy-source-employee').value)?.key || '';
    $('#copy-source-employee').onchange = () => { if ($('#copy-source-employee').value === $('#copy-target-employee').value) $('#copy-target-employee').value = state.bootstrap.employees.find(item => item.key !== $('#copy-source-employee').value)?.key || ''; };
    $('#copy-permissions-button').onclick = async () => { const sourceEmployeeKey = $('#copy-source-employee').value; const targetEmployeeKey = $('#copy-target-employee').value; if (!sourceEmployeeKey || !targetEmployeeKey || sourceEmployeeKey === targetEmployeeKey) return showNotice('请选择不同的源员工和目标员工', true); try { const result = await api('/api/admin/copy-employee-permissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceEmployeeKey, targetEmployeeKey }) }); showNotice(`已复制权限范围（${result.roleKeys.length} 个角色）`); await renderPermissions(); } catch (error) { showNotice(error.message, true); } };
    document.querySelectorAll('.account-visibility-select').forEach(select => select.onchange = async () => { try { await api('/api/admin/set-account-visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleKey: select.dataset.roleKey, visibility: select.value }) }); showNotice('科目名称显示级别已更新'); } catch (error) { showNotice(error.message, true); } });
    document.querySelectorAll('.detail-direction-select').forEach(select => select.onchange = async () => { try { await api('/api/admin/set-detail-preference', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleKey: select.dataset.roleKey, showDirection: select.value === '1' }) }); showNotice('明细借贷方向显示设置已更新'); } catch (error) { showNotice(error.message, true); } });
    document.querySelectorAll('.detail-full-entry-select').forEach(select => select.onchange = async () => { try { await api('/api/admin/set-detail-preference', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleKey: select.dataset.roleKey, showFullEntry: select.value === '1' }) }); showNotice(select.value === '1' ? '跳转明细将展示完整分录' : '跳转明细将只展示所点击科目'); } catch (error) { showNotice(error.message, true); } });
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

let permissionEditorEmployeeKey = null;
const permissionLeafKeys = nodes => nodes.flatMap(node => node.key ? [node.key] : permissionLeafKeys(node.children || []));
const permissionTreeHtml = (nodes, selected, baseline, depth = 0) => nodes.map(node => {
  if (node.key) {
    const checked = selected.has(node.key); const preset = baseline.has(node.key);
    const status = checked === preset ? (checked ? '<em class="preset">预设</em>' : '') : checked ? '<em class="added">已追加</em>' : '<em class="removed">已移除</em>';
    return `<label class="permission-leaf ${checked ? 'selected' : ''}"><input type="checkbox" class="permission-leaf-input" value="${escapeHtml(node.key)}" ${checked ? 'checked' : ''}><span>${escapeHtml(node.name)}</span>${status}</label>`;
  }
  const keys = permissionLeafKeys(node.children || []); const selectedCount = keys.filter(key => selected.has(key)).length;
  return `<section class="permission-tree-node depth-${depth}"><div class="permission-tree-heading"><label><input type="checkbox" class="permission-group-input" data-permission-keys="${keys.join(',')}" ${selectedCount === keys.length ? 'checked' : ''}><span>${escapeHtml(node.name)}</span></label><span class="permission-count">${selectedCount}/${keys.length}</span></div>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}<div class="permission-tree-children">${permissionTreeHtml(node.children || [], selected, baseline, depth + 1)}</div></section>`;
}).join('');

async function renderDeprecatedPermissionWorkbench() {
  const page = $('#permissions-page');
  try {
    const data = await api('/api/admin/roles');
    const context = { data, directory: data.employees.map(item => ({ ...item, source: data.directorySync?.status === 'demo' ? '本地演示通讯录' : '小Q成员组' })), draft: null };
    permissionEditorEmployeeKey = permissionEditorEmployeeKey && data.profiles.some(item => item.employeeKey === permissionEditorEmployeeKey) ? permissionEditorEmployeeKey : (data.profiles.find(item => item.employeeKey === state.employeeKey)?.employeeKey || data.profiles[0]?.employeeKey);
    const syncStatus = data.directorySync?.status || 'never';
    const syncLabel = syncStatus === 'success' ? `已同步 ${data.directorySync.employeeCount || 0} 人` : syncStatus === 'demo' ? '演示数据' : syncStatus === 'failed' ? '同步失败' : '待同步';
    const syncHint = syncStatus === 'failed' ? (data.directorySync.lastError || '点击重试小Q成员同步') : syncStatus === 'success' ? '已同步小Q三个授权组，点击刷新' : '点击同步小Q成员组';
    const watermarkEnabled = state.bootstrap.reportWatermarkEnabled === true;
    page.innerHTML = `<div class="page-title permission-page-title"><div><h1>权限管理</h1><p>从小Q授权成员组中选人，套用角色预设，再按员工微调完整权限树</p></div><span class="permission-mode-badge">角色预设 + 个人覆盖</span></div><section class="panel admin-display-settings"><div><span>管理员设置</span><h2>员工水印</h2><p>开启后，五张财务报表与序时账明细会重复显示当前员工、成员组、公司和期间，仅影响页面展示。</p></div><label class="switch-control"><input id="report-watermark-toggle" type="checkbox" ${watermarkEnabled ? 'checked' : ''}><span aria-hidden="true"></span><strong>${watermarkEnabled ? '已开启' : '已关闭'}</strong></label></section><div class="permission-workflow"><span class="active">1 选择员工</span><i></i><span class="active">2 套用预设</span><i></i><span class="active">3 微调并保存</span></div><div class="permission-workbench"><aside class="panel permission-people-panel"><div class="permission-panel-heading"><div><h2>小Q授权成员</h2><small>姓名或成员组搜索</small></div><button id="permission-sync-button" class="sync-dot ${syncStatus === 'failed' ? 'failed' : ''}" title="${escapeHtml(syncHint)}">${escapeHtml(syncLabel)}</button></div><input id="permission-employee-search" class="permission-search" placeholder="搜索员工或成员组"><div id="permission-employee-list" class="permission-employee-list"></div></aside><main id="permission-editor" class="panel permission-editor"></main><aside id="permission-summary" class="panel permission-summary"></aside></div>`;

    $('#report-watermark-toggle').onchange = async event => {
      const input = event.target; input.disabled = true;
      try {
        const result = await api('/api/admin/report-watermark', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: input.checked }) });
        state.bootstrap.reportWatermarkEnabled = result.enabled; input.closest('label').querySelector('strong').textContent = result.enabled ? '已开启' : '已关闭'; showNotice(result.enabled ? '员工水印已全局开启' : '员工水印已全局关闭');
      } catch (error) { input.checked = !input.checked; showNotice(error.message, true); }
      finally { input.disabled = false; }
    };

    $('#permission-sync-button').onclick = async () => {
      const button = $('#permission-sync-button'); button.disabled = true; button.textContent = '同步中…';
      try { const result = await api('/api/admin/directory-sync', { method: 'POST' }); showNotice(`小Q授权成员已同步 ${result.sync.employeeCount || 0} 人`); await renderPermissions(); }
      catch (error) { button.disabled = false; button.textContent = '同步失败'; button.classList.add('failed'); button.title = error.message; showNotice(error.message, true); }
    };

    const currentEmployee = () => data.employees.find(item => item.employeeKey === permissionEditorEmployeeKey);
    const roleDefault = roleKey => data.roleDefaults.find(item => item.roleKey === roleKey);
    const updateDraft = profile => { context.draft = { ...profile, permissionKeys: [...profile.permissionKeys], companyKeys: [...profile.companyKeys] }; };
    const renderPeople = () => {
      const list = $('#permission-employee-list');
      list.innerHTML = context.directory.map(item => {
        const profile = data.profiles.find(profileItem => profileItem.employeeKey === item.employeeKey); const role = data.roles.find(roleItem => roleItem.key === profile?.presetRoleKey);
        return `<button class="permission-person ${item.employeeKey === permissionEditorEmployeeKey ? 'active' : ''}" data-employee-key="${escapeHtml(item.employeeKey)}"><span class="person-avatar">${escapeHtml(item.name.slice(0, 1))}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.department)}</small></span><em>${escapeHtml(profile?.hasAssignment ? role?.name : '未配置')}</em></button>`;
      }).join('') || '<div class="permission-no-result">没有匹配的小Q授权员工<small>请确认该员工已加入管理员、总经理或财务组，然后点击上方同步状态刷新。</small></div>';
      list.querySelectorAll('.permission-person').forEach(button => button.onclick = () => { permissionEditorEmployeeKey = button.dataset.employeeKey; updateDraft(data.profiles.find(item => item.employeeKey === permissionEditorEmployeeKey)); renderPeople(); renderEditor(); renderSummary(); });
    };

    const renderSummary = () => {
      const draft = context.draft; const employee = currentEmployee(); const baseline = new Set(roleDefault(draft.presetRoleKey)?.permissionKeys || []); const selected = new Set(draft.permissionKeys);
      const added = [...selected].filter(key => !baseline.has(key)).length; const removed = [...baseline].filter(key => !selected.has(key)).length; const risky = draft.permissionKeys.filter(key => key.startsWith('module.permissions.') || key === 'module.database.manage').length;
      const companyText = draft.companyKeys.includes('*') ? '全部公司' : draft.companyKeys.map(companyNameByKey).join('、');
      const targetOptions = data.employees.filter(item => item.employeeKey !== draft.employeeKey).map(item => `<option value="${escapeHtml(item.employeeKey)}">${escapeHtml(item.name)} · ${escapeHtml(item.department)}</option>`).join('');
      const canRemove = draft.hasAssignment && draft.employeeKey !== state.employeeKey;
      $('#permission-summary').innerHTML = `<h2>生效摘要</h2><div class="permission-summary-card"><span>当前员工</span><strong>${escapeHtml(employee?.name)}</strong><small>${escapeHtml(employee?.department)}</small></div><dl><div><dt>授权状态</dt><dd>${draft.hasAssignment ? '已添加' : '未配置'}</dd></div><div><dt>有效权限</dt><dd>${selected.size} 项</dd></div><div><dt>相对预设</dt><dd>${added ? `+${added}` : '0'} / ${removed ? `-${removed}` : '0'}</dd></div><div><dt>数据范围</dt><dd>${escapeHtml(companyText)}</dd></div><div><dt>有效期间</dt><dd>${escapeHtml(draft.fromPeriod)} 至 ${escapeHtml(draft.toPeriod)}</dd></div></dl>${risky ? `<div class="permission-risk">包含 ${risky} 项高风险管理权限，请在保存前复核。</div>` : ''}<div class="permission-copy-box"><strong>复制给新员工</strong><small>完整复制预设、微调项、公司期间范围和明细偏好</small><select id="permission-copy-target">${targetOptions}</select><button class="button" id="permission-copy-button" ${targetOptions ? '' : 'disabled'}>复制当前设定</button></div>${draft.hasAssignment ? `<div class="permission-remove-box"><strong>移除员工授权</strong><small>清除本应用中的角色、个人微调和数据范围，不会删除企微通讯录人员。</small><button class="button danger" id="permission-remove-button" ${canRemove ? '' : 'disabled'}>${draft.employeeKey === state.employeeKey ? '不能移除当前账号' : '移除当前员工授权'}</button></div>` : ''}`;
      $('#permission-copy-button').onclick = async () => { const targetEmployeeKey = $('#permission-copy-target').value; if (!targetEmployeeKey) return; try { await api('/api/admin/copy-employee-permissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceEmployeeKey: draft.employeeKey, targetEmployeeKey }) }); permissionEditorEmployeeKey = targetEmployeeKey; showNotice('员工权限已完整复制'); await renderPermissions(); } catch (error) { showNotice(error.message, true); } };
      $('#permission-remove-button')?.addEventListener('click', async () => { if (!window.confirm(`确定移除“${employee.name}”在本应用中的全部授权吗？\n\n企微通讯录人员不会被删除，之后仍可重新添加权限。`)) return; try { await api('/api/admin/employee-permission-profile', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeKey: draft.employeeKey }) }); showNotice('员工授权已移除'); await renderPermissions(); } catch (error) { showNotice(error.message, true); } });
    };

    const renderEditor = () => {
      const draft = context.draft; const employee = currentEmployee(); const preset = roleDefault(draft.presetRoleKey); const selected = new Set(draft.permissionKeys); const baseline = new Set(preset?.permissionKeys || []);
      const roleOptions = data.roles.map(role => `<option value="${escapeHtml(role.key)}" ${role.key === draft.presetRoleKey ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('');
      const companyChecks = [`<label><input type="checkbox" class="permission-company" value="*" ${draft.companyKeys.includes('*') ? 'checked' : ''}>全部公司</label>`, ...state.bootstrap.companies.map(company => `<label><input type="checkbox" class="permission-company" value="${escapeHtml(company.key)}" ${draft.companyKeys.includes(company.key) ? 'checked' : ''}>${escapeHtml(company.name)}</label>`)].join('');
      const assignmentState = !draft.hasAssignment ? '尚未添加授权' : draft.isCustomized ? '个人权限已保存' : '当前沿用角色预设';
      $('#permission-editor').innerHTML = `<div class="permission-editor-head"><div><span class="person-avatar large">${escapeHtml(employee?.name.slice(0, 1))}</span><div><h2>${escapeHtml(employee?.name)}</h2><small>${escapeHtml(employee?.department)} · ${assignmentState}</small></div></div><span class="permission-save-state ${draft.isCustomized ? 'custom' : ''}">${!draft.hasAssignment ? '未授权' : draft.isCustomized ? '已个性化' : '未微调'}</span></div><section class="permission-config-section"><div class="permission-section-title"><div><h3>角色分组预设</h3><p>应用预设会重置权限树和明细偏好，之后仍可逐项调整</p></div></div><div class="permission-role-row"><select id="permission-role-select">${roleOptions}</select><button class="button" id="permission-apply-role">应用预设</button><span>${escapeHtml(preset?.description || '')}</span></div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>数据范围</h3><p>公司与会计期间对报表和分析接口统一生效</p></div></div><div class="permission-company-grid">${companyChecks}</div><div class="permission-period-row"><label>起始期间<input type="month" id="permission-from-period" value="${escapeHtml(draft.fromPeriod)}"></label><span>至</span><label>结束期间<input type="month" id="permission-to-period" value="${escapeHtml(draft.toPeriod)}"></label></div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>完整权限树</h3><p>“预设”是角色默认；“已追加/已移除”只影响当前员工</p></div><span>${selected.size} 项已选</span></div><div class="permission-tree">${permissionTreeHtml(data.permissionCatalog, selected, baseline)}</div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>明细展示偏好</h3><p>仅在员工拥有明细权限时生效</p></div></div><div class="permission-preference-grid"><label>科目名称<select id="permission-account-visibility"><option value="level1" ${draft.accountVisibility === 'level1' ? 'selected' : ''}>一级科目</option><option value="full" ${draft.accountVisibility === 'full' ? 'selected' : ''}>完整科目</option></select></label><label>借贷方向<select id="permission-show-direction"><option value="1" ${draft.showDirection ? 'selected' : ''}>显示</option><option value="0" ${draft.showDirection ? '' : 'selected'}>隐藏</option></select></label><label>完整分录<select id="permission-show-full-entry"><option value="1" ${draft.showFullEntry ? 'selected' : ''}>展示</option><option value="0" ${draft.showFullEntry ? '' : 'selected'}>隐藏</option></select></label></div></section><div class="permission-save-bar"><span>保存后立即影响该员工下一次接口请求，并写入审计日志。</span><button class="button primary" id="permission-save-button">保存员工权限</button></div>`;
      document.querySelectorAll('.permission-group-input').forEach(input => { const keys = input.dataset.permissionKeys.split(','); const count = keys.filter(key => selected.has(key)).length; input.indeterminate = count > 0 && count < keys.length; input.onchange = () => { keys.forEach(key => input.checked ? selected.add(key) : selected.delete(key)); draft.permissionKeys = [...selected].sort(); renderEditor(); renderSummary(); }; });
      document.querySelectorAll('.permission-leaf-input').forEach(input => input.onchange = () => {
        input.checked ? selected.add(input.value) : selected.delete(input.value);
        if (input.value === 'module.cash_analysis.view' && !input.checked) selected.delete('module.cash_analysis.net_positions.view');
        if (input.value === 'module.cash_analysis.net_positions.view' && input.checked) selected.add('module.cash_analysis.view');
        draft.permissionKeys = [...selected].sort(); renderEditor(); renderSummary();
      });
      document.querySelectorAll('.permission-company').forEach(input => input.onchange = () => { if (input.value === '*' && input.checked) draft.companyKeys = ['*']; else { const values = [...document.querySelectorAll('.permission-company:checked')].map(item => item.value).filter(value => value !== '*'); draft.companyKeys = values.length ? values : ['*']; } renderEditor(); renderSummary(); });
      $('#permission-apply-role').onclick = () => { const next = roleDefault($('#permission-role-select').value); if (!next) return; Object.assign(draft, { presetRoleKey: next.roleKey, permissionKeys: [...next.permissionKeys], accountVisibility: next.accountVisibility, showDirection: next.showDirection, showFullEntry: next.showFullEntry }); renderEditor(); renderSummary(); showNotice(`已应用“${next.name}”预设，可继续微调`); };
      $('#permission-from-period').onchange = event => { draft.fromPeriod = event.target.value; renderSummary(); }; $('#permission-to-period').onchange = event => { draft.toPeriod = event.target.value; renderSummary(); };
      $('#permission-account-visibility').onchange = event => { draft.accountVisibility = event.target.value; }; $('#permission-show-direction').onchange = event => { draft.showDirection = event.target.value === '1'; }; $('#permission-show-full-entry').onchange = event => { draft.showFullEntry = event.target.value === '1'; };
      $('#permission-save-button').onclick = async () => { try { const result = await api('/api/admin/employee-permission-profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) }); const saved = { ...result.profile, name: employee.name, department: employee.department }; data.profiles = data.profiles.map(item => item.employeeKey === saved.employeeKey ? saved : item); updateDraft(saved); showNotice(`员工权限已保存（相对预设 ${result.changes} 项调整）`); await loadBootstrap(); renderPeople(); renderEditor(); renderSummary(); } catch (error) { showNotice(error.message, true); } };
    };

    updateDraft(data.profiles.find(item => item.employeeKey === permissionEditorEmployeeKey)); renderPeople(); renderEditor(); renderSummary();
    let searchTimer; $('#permission-employee-search').oninput = event => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(async () => { try { const result = await api(`/api/admin/directory-employees?search=${encodeURIComponent(event.target.value.trim())}`); context.directory = result.employees; renderPeople(); } catch (error) { showNotice(error.message, true); } }, 180); };
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function renderPermissions() {
  const page = $('#permissions-page');
  try {
    const data = await api('/api/admin/roles');
    await renderPermissionCenter({ page, data, state, api, showNotice, loadBootstrap, companyNameByKey, reload: renderPermissions });
  } catch (error) { page.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function applyReportWatermark() {
  const reportPages = [...reportPageTypes, revenueStatisticsReportType, financialBriefModuleKey];
  const hosts = [$('#report-page'), $('#revenue-statistics-page'), $('#financial-brief-page'), $('#detail-page')];
  hosts.forEach(host => { host.classList.remove('watermark-host'); host.querySelector(':scope > .report-watermark')?.remove(); });
  if (!state.bootstrap?.reportWatermarkEnabled || (!reportPages.includes(state.page) && state.page !== 'journal_detail')) return;
  const host = state.page === 'journal_detail' ? $('#detail-page') : state.page === revenueStatisticsReportType ? $('#revenue-statistics-page') : state.page === financialBriefModuleKey ? $('#financial-brief-page') : $('#report-page');
  const employee = state.bootstrap.employee;
  const watermarkText = `${employee.name} · ${employee.department} · ${currentCompanyName()} · ${state.page === 'journal_detail' && state.detailPeriod ? state.detailPeriod : state.period}`;
  const layer = document.createElement('div'); layer.className = 'report-watermark'; layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = Array.from({ length: 32 }, () => `<span>${escapeHtml(watermarkText)}</span>`).join('');
  host.classList.add('watermark-host'); host.appendChild(layer);
}

let lastPageViewSignature = '';
const recordCurrentPageView = () => {
  if (!state.bootstrap) return;
  const detail = state.consolidatedEntitySheet || (state.page === revenueStatisticsReportType ? state.revenueDimension : '') || sharePageNames[state.page] || reportNames[state.page] || state.page;
  const period = state.page === 'journal_detail' ? (state.detailPeriod || state.period) : state.period;
  const signature = [state.employeeKey, state.page, state.company, period, detail].join('|');
  if (signature === lastPageViewSignature) return;
  lastPageViewSignature = signature;
  void api('/api/activity/page-view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moduleKey: state.page, companyKey: state.company, period, detail }) }).catch(() => { lastPageViewSignature = ''; });
};

async function refresh({ reloadBootstrap = true } = {}) {
  const refreshRevision = ++pageRequestRevision;
  syncPageVisibility(); if (state.page !== financialBriefModuleKey) clearFinancialBriefAutoRefresh(); if (state.page !== consultantRoiModuleKey) clearConsultantRoiAutoRefresh(); setActiveNav();
  if (reloadBootstrap || !state.bootstrap) {
    try { await loadBootstrap(); } catch (error) { showNotice(error.message, true); return; }
  }
  syncPageVisibility();
  const activeHost = pageHostFor(state.page); activeHost?.setAttribute('aria-busy', 'true');
  if (state.page === 'home') renderHome();
  else if (state.page === financialBriefModuleKey) await renderFinancialBrief();
  else if (state.page === activityLogModuleKey) await renderActivityLogs();
  else if (state.page === 'permissions') await renderPermissions();
  else if (state.page === 'uploads') await renderUploads();
  else if (state.page === 'database_admin') await renderDatabaseAdmin();
  else if (state.page === 'cash_analysis') await renderCashAnalysis();
  else if (state.page === 'main_business_analysis') await renderMainBusinessAnalysis();
  else if (state.page === 'expense_analysis') await renderExpenseAnalysis();
  else if (state.page === 'group_profit_analysis') await renderGroupProfitAnalysis();
  else if (state.page === consultantRoiModuleKey) await renderConsultantRoiInteractive();
  else if (state.page === intercompanyModuleKey) await renderIntercompanyReconciliation();
  else if (state.page === revenueStatisticsReportType) await renderRevenueStatistics();
  else if (state.page === 'journal_detail') await renderJournalDetail();
  else { state.reportType = state.page; await refreshReport(); }
  if (refreshRevision !== pageRequestRevision) return;
  activeHost?.removeAttribute('aria-busy');
  applyReportWatermark();
  recordCurrentPageView();
  restartPageArrival();
}

bindShareCard();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.page === financialBriefModuleKey) { clearFinancialBriefAutoRefresh(); renderFinancialBrief({ trigger: 'resume' }); }
  if (document.visibilityState === 'visible' && state.page === consultantRoiModuleKey) { clearConsultantRoiAutoRefresh(); renderConsultantRoiInteractive({ trigger: 'resume' }); }
});
refresh();
