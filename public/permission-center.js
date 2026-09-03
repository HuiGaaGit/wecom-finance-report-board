const ui = {
  view: 'employees',
  editorTab: 'quick',
  category: 'reports',
  matrixFilter: 'all',
  matrixSearch: '',
  selectedEmployeeKey: '',
  mobileDetail: false,
  summaryOpen: false
};

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const hiddenCompanyScopeValue = '__none__';
const cloneProfile = profile => ({ ...profile, permissionKeys: [...(profile?.permissionKeys || [])], companyKeys: [...(profile?.companyKeys || [])] });
const profileSignature = profile => JSON.stringify({
  presetRoleKey: profile?.presetRoleKey || '',
  permissionKeys: [...(profile?.permissionKeys || [])].sort(),
  companyKeys: [...(profile?.companyKeys || [])].sort(),
  fromPeriod: profile?.fromPeriod || '',
  toPeriod: profile?.toPeriod || '',
  accountVisibility: profile?.accountVisibility || 'level1',
  showDirection: profile?.showDirection !== false,
  showFullEntry: profile?.showFullEntry !== false
});
const permissionLeaves = node => {
  const nodes = Array.isArray(node) ? node : [node];
  return nodes.flatMap(item => item?.key ? [item] : permissionLeaves(item?.children || []));
};
const riskPermission = key => key === 'module.uploads.publish' || key === 'module.permissions.manage' || key === 'module.database.manage';
const categoryColumns = {
  reports: [{ key: 'view', name: '浏览' }, { key: 'export', name: '导出' }, { key: 'detail', name: '查看明细' }, { key: 'detail_export', name: '导出明细' }],
  analysis: [{ key: 'view', name: '页面' }, { key: 'sensitive', name: '子模块' }],
  uploads: [{ key: 'upload', name: '上传' }, { key: 'validate', name: '校验' }, { key: 'publish', name: '发布' }],
  system: [{ key: 'view', name: '查看' }, { key: 'manage', name: '管理' }]
};
const analysisPageKeys = ['cash_analysis', 'main_business_analysis', 'expense_analysis'];
const financialBriefViewPermission = 'module.financial_brief.view';
const financialBriefNotesPermission = 'module.financial_brief.notes.manage';
const analysisPagePermission = pageKey => `module.${pageKey}.view`;
const analysisBlockParentFor = key => {
  if (key === financialBriefNotesPermission) return financialBriefViewPermission;
  const pageKey = analysisPageKeys.find(item => String(key).startsWith(`module.${item}.`) && key !== analysisPagePermission(item));
  return pageKey ? analysisPagePermission(pageKey) : '';
};
const actionFor = (category, key) => {
  if (category === 'reports') {
    if (key.endsWith('.summary.view')) return 'view';
    if (key.endsWith('.summary.export')) return 'export';
    if (key.endsWith('.detail.view')) return 'detail';
    if (key.endsWith('.detail.export')) return 'detail_export';
  }
  if (category === 'analysis') return analysisBlockParentFor(key) || key.endsWith('.detail') ? 'sensitive' : 'view';
  if (category === 'uploads') return key.split('.').at(-1);
  if (category === 'system') return key.endsWith('.view') ? 'view' : 'manage';
  return '';
};
const matrixRows = group => {
  if (!group) return [];
  if (group.id === 'reports') return (group.children || []).map(item => ({ id: item.id || item.key, name: String(item.name || '').replace(/\s*·\s*浏览$/, ''), description: item.description || '', leaves: permissionLeaves(item) }));
  if (group.id === 'analysis') return (group.children || []).flatMap(item => {
    if (item.key) return [{ id: item.key, name: String(item.name || '').replace(/\s*·\s*浏览$/, ''), description: item.description || '', leaves: [item] }];
    return (item.children || []).map((leaf, index) => ({ id: leaf.key, name: index === 0 ? item.name : `↳ ${String(leaf.name || '').replace(/^查看/, '')}`, description: index === 0 ? item.description || '' : `隶属于${item.name}`, leaves: [leaf] }));
  });
  if (group.id === 'uploads') return [{ id: 'uploads', name: '报表上传', description: group.description || '', leaves: permissionLeaves(group) }];
  if (group.id === 'system') {
    const leaves = permissionLeaves(group);
    return [
      { id: 'permissions', name: '权限管理', description: '员工授权与权限配置', leaves: leaves.filter(item => item.key.startsWith('module.permissions.')) },
      { id: 'database', name: '数据库管理', description: '数据库浏览与维护', leaves: leaves.filter(item => item.key.startsWith('module.database.')) }
    ].filter(row => row.leaves.length);
  }
  return [];
};
const applyDependencies = (selected, changedKey = '', enabled = true) => {
  if (changedKey === financialBriefViewPermission && !enabled) selected.delete(financialBriefNotesPermission);
  if (selected.has(financialBriefNotesPermission)) selected.add(financialBriefViewPermission);
  if (!selected.has(financialBriefViewPermission)) selected.delete(financialBriefNotesPermission);
  for (const pageKey of analysisPageKeys) {
    const parent = analysisPagePermission(pageKey); const prefix = `module.${pageKey}.`;
    const children = [...selected].filter(key => key.startsWith(prefix) && key !== parent);
    if (changedKey === parent && !enabled) children.forEach(key => selected.delete(key));
    else if (children.length || analysisBlockParentFor(changedKey) === parent && enabled) selected.add(parent);
    if (!selected.has(parent)) [...selected].filter(key => key.startsWith(prefix) && key !== parent).forEach(key => selected.delete(key));
  }
  return selected;
};
const profileChangeCount = (draft, original) => {
  if (!draft || !original) return 0;
  let count = 0;
  const fields = ['presetRoleKey', 'fromPeriod', 'toPeriod', 'accountVisibility', 'showDirection', 'showFullEntry'];
  fields.forEach(field => { if (draft[field] !== original[field]) count += 1; });
  const changedSet = (left, right) => new Set([...left, ...right]).size - [...new Set(left)].filter(value => new Set(right).has(value)).length;
  count += changedSet(draft.permissionKeys || [], original.permissionKeys || []);
  count += changedSet(draft.companyKeys || [], original.companyKeys || []);
  return count;
};
const companyScopeForSelection = (checkedValues, changedValue = '', checked = false) => {
  const values = [...new Set((checkedValues || []).map(String))];
  if (changedValue === hiddenCompanyScopeValue && checked) return [];
  if (changedValue === '*' && checked) return ['*'];
  return values.filter(value => value !== '*' && value !== hiddenCompanyScopeValue);
};

export async function renderPermissionCenter(options) {
  const { page, data, state, api, showNotice, loadBootstrap, companyNameByKey } = options;
  const model = {
    directory: data.employees.map(item => ({ ...item, source: data.directorySync?.status === 'demo' ? '本地演示通讯录' : '小Q成员组' })),
    draft: null,
    original: null
  };
  const roleDefault = roleKey => data.roleDefaults.find(item => item.roleKey === roleKey);
  const employee = () => data.employees.find(item => item.employeeKey === ui.selectedEmployeeKey);
  const profile = key => data.profiles.find(item => item.employeeKey === key);
  const isDirty = () => profileSignature(model.draft) !== profileSignature(model.original);
  const setProfile = value => { model.draft = cloneProfile(value); model.original = cloneProfile(value); };
  const validSelected = data.profiles.some(item => item.employeeKey === ui.selectedEmployeeKey);
  ui.selectedEmployeeKey = validSelected ? ui.selectedEmployeeKey : (profile(state.employeeKey)?.employeeKey || data.profiles[0]?.employeeKey || '');
  if (ui.selectedEmployeeKey) setProfile(profile(ui.selectedEmployeeKey));

  const switchEmployee = key => {
    if (key === ui.selectedEmployeeKey) { ui.mobileDetail = true; renderEmployeeView(); return; }
    if (isDirty() && !window.confirm('当前员工有未保存的修改，确定放弃并切换员工吗？')) return;
    ui.selectedEmployeeKey = key; ui.mobileDetail = true; ui.summaryOpen = false; setProfile(profile(key)); renderEmployeeView();
  };

  const shell = () => {
    page.innerHTML = `<div class="page-title permission-page-title"><div><h1>权限中心</h1><p>按员工配置角色基线、数据范围和模块权限，业务模块增加时仍保持清晰</p></div><span class="permission-mode-badge">角色预设 + 个人微调</span></div><nav class="permission-center-tabs" aria-label="权限中心视图">${[['employees', '员工授权'], ['roles', '角色预设'], ['audit', '授权审计'], ['global', '全局设置']].map(([key, name]) => `<button type="button" data-center-view="${key}" class="${ui.view === key ? 'active' : ''}">${name}</button>`).join('')}</nav><div id="permission-center-content"></div>`;
    page.querySelectorAll('[data-center-view]').forEach(button => button.onclick = () => {
      if (button.dataset.centerView === ui.view) return;
      if (ui.view === 'employees' && isDirty() && !window.confirm('当前员工有未保存的修改，确定离开吗？')) return;
      ui.view = button.dataset.centerView; ui.summaryOpen = false; shell(); renderView();
    });
  };

  const renderPeople = () => {
    const list = page.querySelector('#permission-employee-list');
    if (!list) return;
    list.innerHTML = model.directory.map(item => {
      const itemProfile = profile(item.employeeKey); const role = data.roles.find(roleItem => roleItem.key === itemProfile?.presetRoleKey);
      return `<button type="button" class="permission-person ${item.employeeKey === ui.selectedEmployeeKey ? 'active' : ''}" data-employee-key="${escapeHtml(item.employeeKey)}"><span class="person-avatar">${escapeHtml(item.name.slice(0, 1))}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.department)}</small></span><em>${escapeHtml(itemProfile?.hasAssignment ? role?.name : '未配置')}</em></button>`;
    }).join('') || '<div class="permission-no-result">没有匹配的小Q授权员工<small>请确认员工已加入管理员、总经理或财务组，再刷新成员目录。</small></div>';
    list.querySelectorAll('[data-employee-key]').forEach(button => button.onclick = () => switchEmployee(button.dataset.employeeKey));
  };

  const permissionStatus = (leaves, selected, baseline) => {
    const added = leaves.filter(item => selected.has(item.key) && !baseline.has(item.key)).length;
    const removed = leaves.filter(item => !selected.has(item.key) && baseline.has(item.key)).length;
    if (added || removed) return `<span class="permission-row-status adjusted">${added ? `+${added}` : ''}${added && removed ? ' / ' : ''}${removed ? `-${removed}` : ''}</span>`;
    if (leaves.some(item => selected.has(item.key))) return '<span class="permission-row-status preset">预设</span>';
    return '<span class="permission-row-status off">未开启</span>';
  };

  const matrixHtml = () => {
    const draft = model.draft; const selected = new Set(draft.permissionKeys); const baseline = new Set(roleDefault(draft.presetRoleKey)?.permissionKeys || []);
    const group = data.permissionCatalog.find(item => item.id === ui.category); const columns = categoryColumns[ui.category] || [];
    const search = ui.matrixSearch.trim().toLowerCase();
    const rows = matrixRows(group).filter(row => {
      const adjusted = row.leaves.some(item => selected.has(item.key) !== baseline.has(item.key));
      const enabled = row.leaves.some(item => selected.has(item.key));
      const risky = row.leaves.some(item => riskPermission(item.key));
      if (search && !`${row.name} ${row.description} ${row.leaves.map(item => item.name).join(' ')}`.toLowerCase().includes(search)) return false;
      if (ui.matrixFilter === 'enabled' && !enabled) return false;
      if (ui.matrixFilter === 'adjusted' && !adjusted) return false;
      if (ui.matrixFilter === 'risk' && !risky) return false;
      return true;
    });
    const allKeys = permissionLeaves(group || []).map(item => item.key); const enabledCount = allKeys.filter(key => selected.has(key)).length;
    return `<div class="permission-matrix-toolbar"><span>本分类已开启 <strong>${enabledCount}</strong> / ${allKeys.length}</span><div><button type="button" class="button compact" data-category-action="enable">全部开启</button><button type="button" class="button compact" data-category-action="clear">全部关闭</button><button type="button" class="button compact" data-category-action="reset">恢复预设</button></div></div><div class="permission-matrix" style="--permission-action-columns:${columns.length}"><div class="permission-matrix-head"><span>模块</span>${columns.map(column => `<span>${escapeHtml(column.name)}</span>`).join('')}<span>状态</span><span>操作</span></div>${rows.map(row => `<div class="permission-matrix-row"><div class="permission-module-name"><strong>${escapeHtml(row.name)}</strong>${row.description ? `<small>${escapeHtml(row.description)}</small>` : ''}</div>${columns.map(column => { const leaf = row.leaves.find(item => actionFor(ui.category, item.key) === column.key); return leaf ? `<label class="permission-action-toggle ${riskPermission(leaf.key) ? 'risky' : ''}" title="${escapeHtml(leaf.name)}"><input type="checkbox" data-permission-key="${escapeHtml(leaf.key)}" ${selected.has(leaf.key) ? 'checked' : ''}><span aria-hidden="true"></span><b class="sr-only">${escapeHtml(leaf.name)}</b></label>` : '<span class="permission-action-na">—</span>'; }).join('')}<div>${permissionStatus(row.leaves, selected, baseline)}</div><button type="button" class="permission-row-reset" data-reset-row="${escapeHtml(row.id)}">重置</button></div>`).join('') || '<div class="permission-matrix-empty">没有符合当前筛选条件的模块</div>'}</div>`;
  };

  const bindMatrix = () => {
    const host = page.querySelector('#permission-matrix-content'); if (!host) return;
    host.querySelectorAll('[data-permission-key]').forEach(input => input.onchange = () => {
      const selected = new Set(model.draft.permissionKeys); input.checked ? selected.add(input.dataset.permissionKey) : selected.delete(input.dataset.permissionKey);
      applyDependencies(selected, input.dataset.permissionKey, input.checked); model.draft.permissionKeys = [...selected].sort(); renderEditor();
    });
    host.querySelectorAll('[data-category-action]').forEach(button => button.onclick = () => {
      const group = data.permissionCatalog.find(item => item.id === ui.category); const keys = permissionLeaves(group || []).map(item => item.key); const baseline = new Set(roleDefault(model.draft.presetRoleKey)?.permissionKeys || []); const selected = new Set(model.draft.permissionKeys);
      keys.forEach(key => { if (button.dataset.categoryAction === 'enable' || (button.dataset.categoryAction === 'reset' && baseline.has(key))) selected.add(key); else selected.delete(key); });
      applyDependencies(selected); model.draft.permissionKeys = [...selected].sort(); renderEditor();
    });
    host.querySelectorAll('[data-reset-row]').forEach(button => button.onclick = () => {
      const group = data.permissionCatalog.find(item => item.id === ui.category); const row = matrixRows(group).find(item => item.id === button.dataset.resetRow); const baseline = new Set(roleDefault(model.draft.presetRoleKey)?.permissionKeys || []); const selected = new Set(model.draft.permissionKeys);
      row?.leaves.forEach(item => baseline.has(item.key) ? selected.add(item.key) : selected.delete(item.key)); applyDependencies(selected); model.draft.permissionKeys = [...selected].sort(); renderEditor();
    });
  };

  const quickHtml = () => {
    const draft = model.draft; const preset = roleDefault(draft.presetRoleKey);
    const roleOptions = data.roles.map(role => `<option value="${escapeHtml(role.key)}" ${role.key === draft.presetRoleKey ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('');
    const companyChecks = [
      `<label class="permission-company-hidden"><input type="checkbox" class="permission-company" value="${hiddenCompanyScopeValue}" ${draft.companyKeys.length === 0 ? 'checked' : ''}>全部不可见</label>`,
      `<label><input type="checkbox" class="permission-company" value="*" ${draft.companyKeys.includes('*') ? 'checked' : ''}>全部公司</label>`,
      ...state.bootstrap.companies.map(company => `<label><input type="checkbox" class="permission-company" value="${escapeHtml(company.key)}" ${draft.companyKeys.includes(company.key) ? 'checked' : ''}>${escapeHtml(company.name)}</label>`)
    ].join('');
    const targets = data.employees.filter(item => item.employeeKey !== draft.employeeKey).map(item => `<option value="${escapeHtml(item.employeeKey)}">${escapeHtml(item.name)} · ${escapeHtml(item.department)}</option>`).join('');
    return `<section class="permission-config-section"><div class="permission-section-title"><div><h3>角色分组预设</h3><p>先应用常用岗位基线，再做个人微调</p></div></div><div class="permission-role-row"><select id="permission-role-select">${roleOptions}</select><button type="button" class="button" id="permission-apply-role">应用预设</button><span>${escapeHtml(preset?.description || '')}</span></div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>数据范围</h3><p>未配置员工默认全部不可见；公司和期间范围对报表、分析、上传及下钻接口统一生效</p></div></div><div class="permission-company-grid">${companyChecks}</div><div class="permission-period-row"><label>起始期间<input type="month" id="permission-from-period" value="${escapeHtml(draft.fromPeriod)}"></label><span>至</span><label>结束期间<input type="month" id="permission-to-period" value="${escapeHtml(draft.toPeriod)}"></label></div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>常用权限组合</h3><p>仅调整财务报表与经营分析，不改变上传和系统管理权限</p></div></div><div class="permission-bundle-grid">${[['view', '仅浏览', '报表浏览 + 分析浏览'], ['export', '浏览并导出', '增加报表导出'], ['detail', '浏览并查看明细', '增加报表明细'], ['full', '完整财务权限', '报表与分析全部开启'], ['clear', '清空业务权限', '关闭报表与分析']].map(([key, name, description]) => `<button type="button" data-permission-bundle="${key}"><strong>${name}</strong><small>${description}</small></button>`).join('')}</div></section><section class="permission-config-section"><div class="permission-section-title"><div><h3>复制已保存设定</h3><p>完整复制当前员工的角色、个人微调、数据范围和高级设置</p></div></div><div class="permission-copy-inline"><select id="permission-copy-target">${targets}</select><button type="button" class="button" id="permission-copy-button" ${targets ? '' : 'disabled'}>复制给该员工</button></div><small class="permission-inline-note">若当前有未保存修改，请先保存后再复制。</small></section>`;
  };

  const matrixPanelHtml = () => `<section class="permission-config-section permission-matrix-section"><div class="permission-section-title"><div><h3>模块权限</h3><p>按分类查看；不支持的动作显示为“—”</p></div><span>${model.draft.permissionKeys.length} 项已开启</span></div><div class="permission-category-tabs">${data.permissionCatalog.map(group => `<button type="button" data-permission-category="${escapeHtml(group.id)}" class="${ui.category === group.id ? 'active' : ''}">${escapeHtml(group.name)}<small>${permissionLeaves(group).filter(item => model.draft.permissionKeys.includes(item.key)).length}/${permissionLeaves(group).length}</small></button>`).join('')}</div><div class="permission-matrix-filters"><input id="permission-matrix-search" value="${escapeHtml(ui.matrixSearch)}" placeholder="搜索模块或权限"><div>${[['all', '全部'], ['enabled', '已开启'], ['adjusted', '个人调整'], ['risk', '高风险']].map(([key, name]) => `<button type="button" data-matrix-filter="${key}" class="${ui.matrixFilter === key ? 'active' : ''}">${name}</button>`).join('')}</div></div><div id="permission-matrix-content">${matrixHtml()}</div></section>`;

  const advancedHtml = () => {
    const draft = model.draft; const current = employee(); const canRemove = draft.hasAssignment && draft.employeeKey !== state.employeeKey;
    return `<section class="permission-config-section"><div class="permission-section-title"><div><h3>明细展示偏好</h3><p>仅在员工拥有查看明细权限时生效</p></div></div><div class="permission-preference-grid"><label>科目名称<select id="permission-account-visibility"><option value="level1" ${draft.accountVisibility === 'level1' ? 'selected' : ''}>一级科目</option><option value="full" ${draft.accountVisibility === 'full' ? 'selected' : ''}>完整科目</option></select></label><label>借贷方向<select id="permission-show-direction"><option value="1" ${draft.showDirection ? 'selected' : ''}>显示</option><option value="0" ${draft.showDirection ? '' : 'selected'}>隐藏</option></select></label><label>完整分录<select id="permission-show-full-entry"><option value="1" ${draft.showFullEntry ? 'selected' : ''}>展示</option><option value="0" ${draft.showFullEntry ? '' : 'selected'}>隐藏</option></select></label></div></section><section class="permission-config-section permission-danger-zone"><div><h3>移除员工授权</h3><p>清除本应用中的角色、个人微调和数据范围，不会删除企微通讯录人员。</p></div>${draft.hasAssignment ? `<button type="button" class="button danger" id="permission-remove-button" ${canRemove ? '' : 'disabled'}>${draft.employeeKey === state.employeeKey ? '不能移除当前账号' : `移除 ${escapeHtml(current?.name)} 的授权`}</button>` : '<span>当前员工尚未添加授权</span>'}</section>`;
  };

  const applyBundle = key => {
    const selected = new Set(model.draft.permissionKeys); const businessLeaves = data.permissionCatalog.filter(group => ['reports', 'analysis'].includes(group.id)).flatMap(permissionLeaves);
    businessLeaves.forEach(item => selected.delete(item.key));
    if (key !== 'clear') businessLeaves.forEach(item => {
      const isReport = item.key.startsWith('report.'); const view = item.key.endsWith('.summary.view') || item.key.startsWith('module.') && item.key.endsWith('.view');
      if (key === 'full' || view || key === 'export' && isReport && item.key.endsWith('.summary.export') || key === 'detail' && isReport && item.key.endsWith('.detail.view')) selected.add(item.key);
    });
    applyDependencies(selected); model.draft.permissionKeys = [...selected].sort(); renderEditor(); showNotice('常用权限组合已应用，保存前仍可继续微调');
  };

  const summaryHtml = () => {
    const draft = model.draft; const current = employee(); const baseline = new Set(roleDefault(draft.presetRoleKey)?.permissionKeys || []); const selected = new Set(draft.permissionKeys);
    const added = [...selected].filter(key => !baseline.has(key)).length; const removed = [...baseline].filter(key => !selected.has(key)).length; const risky = [...selected].filter(riskPermission);
    const companies = draft.companyKeys.length === 0 ? '全部不可见' : draft.companyKeys.includes('*') ? '全部公司' : draft.companyKeys.map(companyNameByKey).join('、');
    return `<div class="permission-drawer-backdrop" data-close-summary></div><aside class="permission-summary-drawer" role="dialog" aria-modal="true" aria-label="生效摘要"><div class="permission-drawer-head"><div><span>保存后生效</span><h2>授权摘要</h2></div><button type="button" data-close-summary aria-label="关闭">×</button></div><div class="permission-summary-card"><span>当前员工</span><strong>${escapeHtml(current?.name)}</strong><small>${escapeHtml(current?.department)}</small></div><dl><div><dt>授权状态</dt><dd>${draft.hasAssignment ? '已添加' : '待添加'}</dd></div><div><dt>角色预设</dt><dd>${escapeHtml(roleDefault(draft.presetRoleKey)?.name || '')}</dd></div><div><dt>有效权限</dt><dd>${selected.size} 项</dd></div><div><dt>相对预设</dt><dd>+${added} / -${removed}</dd></div><div><dt>数据范围</dt><dd>${escapeHtml(companies || '未选择')}</dd></div><div><dt>有效期间</dt><dd>${escapeHtml(draft.fromPeriod)} 至 ${escapeHtml(draft.toPeriod)}</dd></div></dl>${risky.length ? `<div class="permission-risk">包含 ${risky.length} 项高风险权限：${escapeHtml(risky.map(key => permissionLeaves(data.permissionCatalog).find(item => item.key === key)?.name || key).join('、'))}</div>` : '<div class="permission-safe">未开启高风险管理权限</div>'}</aside>`;
  };

  const renderSummary = () => {
    page.querySelector('#permission-summary-layer')?.remove();
    if (!ui.summaryOpen || !model.draft) return;
    const layer = document.createElement('div'); layer.id = 'permission-summary-layer'; layer.innerHTML = summaryHtml(); page.appendChild(layer);
    layer.querySelectorAll('[data-close-summary]').forEach(button => button.onclick = () => { ui.summaryOpen = false; renderSummary(); });
  };

  const saveDraft = async () => {
    try {
      const current = employee(); const result = await api('/api/admin/employee-permission-profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(model.draft) });
      const saved = { ...result.profile, name: current.name, department: current.department };
      data.profiles = data.profiles.map(item => item.employeeKey === saved.employeeKey ? saved : item); setProfile(saved); await loadBootstrap();
      showNotice(`员工权限已保存（相对预设 ${result.changes} 项调整）`); renderEmployeeView();
    } catch (error) { showNotice(error.message, true); }
  };

  const renderEditor = () => {
    const host = page.querySelector('#permission-editor'); if (!host || !model.draft) return;
    const draft = model.draft; const current = employee(); const dirtyCount = profileChangeCount(draft, model.original); const assignmentState = !draft.hasAssignment ? '尚未添加授权' : draft.isCustomized ? '个人权限已保存' : '当前沿用角色预设';
    const tabBody = ui.editorTab === 'quick' ? quickHtml() : ui.editorTab === 'matrix' ? matrixPanelHtml() : advancedHtml();
    host.innerHTML = `<div class="permission-editor-head"><button type="button" class="permission-mobile-back" id="permission-mobile-back">‹ 返回员工</button><div><span class="person-avatar large">${escapeHtml(current?.name.slice(0, 1))}</span><div><h2>${escapeHtml(current?.name)}</h2><small>${escapeHtml(current?.department)} · ${assignmentState}</small></div></div><span class="permission-save-state ${dirtyCount ? 'dirty' : draft.isCustomized ? 'custom' : ''}">${dirtyCount ? `${dirtyCount} 项待保存` : !draft.hasAssignment ? '未授权' : draft.isCustomized ? '已个性化' : '未微调'}</span></div><nav class="permission-editor-tabs">${[['quick', '快速配置'], ['matrix', '模块权限'], ['advanced', '高级设置']].map(([key, name]) => `<button type="button" data-editor-tab="${key}" class="${ui.editorTab === key ? 'active' : ''}">${name}</button>`).join('')}</nav><div class="permission-editor-body">${tabBody}</div><div class="permission-save-bar"><span>${dirtyCount ? `有 ${dirtyCount} 项未保存修改` : '当前设置已保存'} · 保存后立即影响该员工下一次接口请求</span><div><button type="button" class="button" id="permission-summary-button">查看生效摘要</button><button type="button" class="button" id="permission-cancel-button" ${dirtyCount ? '' : 'disabled'}>取消修改</button><button type="button" class="button primary" id="permission-save-button" ${dirtyCount || !draft.hasAssignment ? '' : 'disabled'}>保存员工权限</button></div></div>`;
    host.querySelector('#permission-mobile-back').onclick = () => { if (isDirty() && !window.confirm('当前员工有未保存的修改，确定返回员工列表吗？')) return; ui.mobileDetail = false; renderEmployeeView(); };
    host.querySelectorAll('[data-editor-tab]').forEach(button => button.onclick = () => { ui.editorTab = button.dataset.editorTab; renderEditor(); });
    host.querySelector('#permission-summary-button').onclick = () => { ui.summaryOpen = true; renderSummary(); };
    host.querySelector('#permission-cancel-button').onclick = () => { model.draft = cloneProfile(model.original); renderEditor(); };
    host.querySelector('#permission-save-button').onclick = saveDraft;
    bindEditorTab();
  };

  const bindEditorTab = () => {
    const host = page.querySelector('#permission-editor'); if (!host) return;
    if (ui.editorTab === 'quick') {
      host.querySelectorAll('.permission-company').forEach(input => input.onchange = () => {
        const values = [...host.querySelectorAll('.permission-company:checked')].map(item => item.value);
        model.draft.companyKeys = companyScopeForSelection(values, input.value, input.checked);
        renderEditor();
      });
      host.querySelector('#permission-apply-role').onclick = () => {
        const next = roleDefault(host.querySelector('#permission-role-select').value); if (!next) return;
        Object.assign(model.draft, { presetRoleKey: next.roleKey, permissionKeys: [...next.permissionKeys], accountVisibility: next.accountVisibility, showDirection: next.showDirection, showFullEntry: next.showFullEntry });
        renderEditor(); showNotice(`已应用“${next.name}”预设，可继续微调`);
      };
      host.querySelector('#permission-from-period').onchange = event => { model.draft.fromPeriod = event.target.value; renderEditor(); };
      host.querySelector('#permission-to-period').onchange = event => { model.draft.toPeriod = event.target.value; renderEditor(); };
      host.querySelectorAll('[data-permission-bundle]').forEach(button => button.onclick = () => applyBundle(button.dataset.permissionBundle));
      host.querySelector('#permission-copy-button').onclick = async () => {
        if (isDirty()) return showNotice('请先保存当前员工的修改，再复制已保存设定', true);
        const targetEmployeeKey = host.querySelector('#permission-copy-target').value; if (!targetEmployeeKey) return;
        try { await api('/api/admin/copy-employee-permissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceEmployeeKey: model.draft.employeeKey, targetEmployeeKey }) }); ui.selectedEmployeeKey = targetEmployeeKey; showNotice('员工权限已完整复制'); await options.reload(); }
        catch (error) { showNotice(error.message, true); }
      };
    }
    if (ui.editorTab === 'matrix') {
      host.querySelectorAll('[data-permission-category]').forEach(button => button.onclick = () => { ui.category = button.dataset.permissionCategory; renderEditor(); });
      host.querySelectorAll('[data-matrix-filter]').forEach(button => button.onclick = () => { ui.matrixFilter = button.dataset.matrixFilter; renderEditor(); });
      host.querySelector('#permission-matrix-search').oninput = event => { ui.matrixSearch = event.target.value; const matrix = host.querySelector('#permission-matrix-content'); matrix.innerHTML = matrixHtml(); bindMatrix(); };
      bindMatrix();
    }
    if (ui.editorTab === 'advanced') {
      host.querySelector('#permission-account-visibility').onchange = event => { model.draft.accountVisibility = event.target.value; renderEditor(); };
      host.querySelector('#permission-show-direction').onchange = event => { model.draft.showDirection = event.target.value === '1'; renderEditor(); };
      host.querySelector('#permission-show-full-entry').onchange = event => { model.draft.showFullEntry = event.target.value === '1'; renderEditor(); };
      host.querySelector('#permission-remove-button')?.addEventListener('click', async () => {
        const current = employee(); if (!window.confirm(`确定移除“${current.name}”在本应用中的全部授权吗？\n\n企微通讯录人员不会被删除，之后仍可重新添加权限。`)) return;
        try { await api('/api/admin/employee-permission-profile', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employeeKey: model.draft.employeeKey }) }); showNotice('员工授权已移除'); await options.reload(); }
        catch (error) { showNotice(error.message, true); }
      });
    }
  };

  const renderEmployeeView = () => {
    const content = page.querySelector('#permission-center-content');
    const sync = data.directorySync || {}; const syncStatus = sync.status || 'never'; const syncLabel = syncStatus === 'success' ? `已同步 ${sync.employeeCount || 0} 人` : syncStatus === 'demo' ? '演示数据' : syncStatus === 'failed' ? '同步失败' : '待同步';
    content.innerHTML = `<div class="permission-workbench ${ui.mobileDetail ? 'mobile-detail' : ''}"><aside class="panel permission-people-panel"><div class="permission-panel-heading"><div><h2>小Q授权成员</h2><small>按姓名或部门搜索</small></div><button type="button" id="permission-sync-button" class="sync-dot ${syncStatus === 'failed' ? 'failed' : ''}">${escapeHtml(syncLabel)}</button></div><input id="permission-employee-search" class="permission-search" placeholder="搜索员工或部门"><div id="permission-employee-list" class="permission-employee-list"></div></aside><main id="permission-editor" class="panel permission-editor"></main></div>`;
    renderPeople(); renderEditor(); renderSummary();
    content.querySelector('#permission-sync-button').onclick = async () => {
      const button = content.querySelector('#permission-sync-button'); button.disabled = true; button.textContent = '同步中…';
      try { const result = await api('/api/admin/directory-sync', { method: 'POST' }); showNotice(`小Q授权成员已同步 ${result.sync.employeeCount || 0} 人`); await options.reload(); }
      catch (error) { button.disabled = false; button.textContent = '同步失败'; button.classList.add('failed'); showNotice(error.message, true); }
    };
    let searchTimer; content.querySelector('#permission-employee-search').oninput = event => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(async () => { try { const result = await api(`/api/admin/directory-employees?search=${encodeURIComponent(event.target.value.trim())}`); model.directory = result.employees; renderPeople(); } catch (error) { showNotice(error.message, true); } }, 180); };
  };

  const renderRoles = () => {
    const content = page.querySelector('#permission-center-content');
    content.innerHTML = `<section class="panel permission-center-panel"><div class="permission-center-panel-head"><div><h2>角色预设</h2><p>预设是员工授权的起点；个人微调不会影响同角色其他员工。</p></div><span>本阶段只读</span></div><div class="permission-role-cards">${data.roleDefaults.map(role => { const count = data.profiles.filter(item => item.hasAssignment && item.presetRoleKey === role.roleKey).length; const scope = !role.companyKeys?.length ? '全部不可见' : role.companyKeys.includes('*') ? '全部公司' : role.companyKeys.length + ' 家'; return `<article><div><strong>${escapeHtml(role.name)}</strong><span>${count} 人使用</span></div><p>${escapeHtml(role.description || '暂无说明')}</p><dl><div><dt>默认权限</dt><dd>${role.permissionKeys.length} 项</dd></div><div><dt>公司范围</dt><dd>${scope}</dd></div><div><dt>期间</dt><dd>${escapeHtml(role.fromPeriod)} 至 ${escapeHtml(role.toPeriod)}</dd></div></dl></article>`; }).join('')}</div><div class="permission-planned-note">角色模板编辑、复制和批量分配将在权限数据模型升级后开放；当前不提供无后端支撑的伪操作。</div></section>`;
  };

  const renderAudit = () => {
    const content = page.querySelector('#permission-center-content'); const rows = data.profiles.filter(item => item.hasAssignment).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    content.innerHTML = `<section class="panel permission-center-panel"><div class="permission-center-panel-head"><div><h2>授权审计</h2><p>先展示当前接口可核验的员工授权档案状态。</p></div><span>${rows.length} 名已授权员工</span></div><div class="permission-audit-list">${rows.map(item => { const role = roleDefault(item.presetRoleKey); const baseline = new Set(role?.permissionKeys || []); const selected = new Set(item.permissionKeys); const changes = [...selected].filter(key => !baseline.has(key)).length + [...baseline].filter(key => !selected.has(key)).length; return `<article><span class="person-avatar">${escapeHtml(item.name.slice(0, 1))}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.department)} · ${escapeHtml(role?.name || '')}</small></div><div><strong>${item.permissionKeys.length} 项权限</strong><small>${changes ? `${changes} 项个人调整` : '沿用角色预设'}</small></div><time>${escapeHtml(item.updatedAt || '未记录更新时间')}</time></article>`; }).join('') || '<div class="permission-no-result">暂无已授权员工</div>'}</div><div class="permission-planned-note">服务器已记录权限保存、复制和移除操作；完整审计日志查询接口尚未开放，本页不会推测或伪造操作人和历史记录。</div></section>`;
  };

  const renderGlobal = () => {
    const content = page.querySelector('#permission-center-content'); const enabled = state.bootstrap.reportWatermarkEnabled === true;
    content.innerHTML = `<section class="panel permission-center-panel"><div class="permission-center-panel-head"><div><h2>全局设置</h2><p>影响所有员工的展示策略集中在这里管理。</p></div></div><div class="permission-global-setting"><div><span>报表安全</span><h3>员工水印</h3><p>开启后，财务报表与序时账明细重复显示当前员工、真实部门、公司和期间，仅影响页面展示。</p></div><label class="switch-control"><input id="report-watermark-toggle" type="checkbox" ${enabled ? 'checked' : ''}><span aria-hidden="true"></span><strong>${enabled ? '已开启' : '已关闭'}</strong></label></div></section>`;
    content.querySelector('#report-watermark-toggle').onchange = async event => {
      const input = event.target; input.disabled = true;
      try { const result = await api('/api/admin/report-watermark', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: input.checked }) }); state.bootstrap.reportWatermarkEnabled = result.enabled; input.closest('label').querySelector('strong').textContent = result.enabled ? '已开启' : '已关闭'; showNotice(result.enabled ? '员工水印已全局开启' : '员工水印已全局关闭'); }
      catch (error) { input.checked = !input.checked; showNotice(error.message, true); }
      finally { input.disabled = false; }
    };
  };

  const renderView = () => {
    if (ui.view === 'employees') renderEmployeeView();
    else if (ui.view === 'roles') renderRoles();
    else if (ui.view === 'audit') renderAudit();
    else renderGlobal();
  };

  shell(); renderView();
}

export const permissionCenterTestHelpers = { actionFor, applyDependencies, companyScopeForSelection, matrixRows, profileSignature, riskPermission };
