const textFor = value => String(value ?? '').trim();

const normalizedText = value => textFor(value)
  .replace(/[\s\n\r\t【】\[\]（）()，,：:、·—–-]/g, '')
  .replace(/[的之]/g, '');

const amountFor = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = textFor(value);
  if (!source || /^(?:[-—–]|无|不适用)$/.test(source)) return null;
  const negative = /^\(.+\)$/.test(source) || /^（.+）$/.test(source);
  const parsed = Number(source.replace(/[(),，（）￥¥元\s]/g, '').replace(/^[^-\d.]*/, ''));
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
};

const rounded = value => Number(Number(value || 0).toFixed(2));
const rowCells = row => Array.isArray(row) ? row : (Array.isArray(row?.cells) ? row.cells : []);
const sourceRowNumber = (row, index) => Number(row?.row) || index + 1;

const sourceMappings = [
  ['opening_cash', /期初现金|期初余额/],
  ['sales_receipts', /销售收入|销售商品.*收到现金|提供劳务.*收到现金|经营收入/],
  ['other_income', /其他收入|其他流入/],
  ['tax_refunds', /税费返还|退税/],
  ['receivables_collected', /收回.*款|收款|应收.*收回/],
  ['investment_receipts', /吸收投资.*现金|投资款|投资收到现金/],
  ['borrowings_received', /借款.*收到|取得借款/]
];

const destinationMappings = [
  ['operating_cost', /经营成本|项目成本|营业成本/],
  ['commission_expense', /佣金支出|佣金费用/],
  ['payroll', /员工工资.*福利|工资.*社保|职工薪酬|人员费用/],
  ['taxes', /税费支出|支付.*税费|缴纳.*税费/],
  ['operating_expense', /日常运营费用|运营费用|日常费用/],
  ['fixed_asset_purchase', /固定资产.*购置|购建固定资产/],
  ['financing_payment', /融资支付|融资费用/],
  ['loan_repayment', /偿还.*借款|归还.*借款|借款/],
  ['deposit_payment', /租赁保证金|保证金|押金/],
  ['investment_payment', /投资支付|投资.*现金/]
];

const keyFor = (label, side) => {
  const mappings = side === 'source' ? sourceMappings : destinationMappings;
  return mappings.find(([, pattern]) => pattern.test(normalizedText(label)))?.[0] || 'other';
};

const directionFor = value => {
  const normalized = normalizedText(value);
  if (/^(?:期初|加|增加|流入|收入)$/.test(normalized)) return 'source';
  if (/^(?:减|减少|流出|支出)$/.test(normalized)) return 'destination';
  return '';
};

const headerNearAnchor = (rows, anchor) => {
  for (let rowIndex = anchor.rowIndex; rowIndex <= Math.min(rows.length - 1, anchor.rowIndex + 6); rowIndex += 1) {
    const cells = rowCells(rows[rowIndex]);
    const start = Math.max(0, anchor.columnIndex - 2); const end = Math.min(cells.length - 1, anchor.columnIndex + 9);
    const directionIndex = cells.findIndex((value, index) => index >= start && index <= end && /^(?:增减项|增减方向|收支类型|类型)$/.test(normalizedText(value)));
    if (directionIndex < 0) continue;
    const projectIndex = cells.findIndex((value, index) => index > directionIndex && index <= end && /^项目(?:名称)?$/.test(normalizedText(value)));
    const amountIndex = cells.findIndex((value, index) => index > projectIndex && index <= end && /^(?:金额|发生额)$/.test(normalizedText(value)));
    if (projectIndex >= 0 && amountIndex >= 0) return { rowIndex, directionIndex, projectIndex, amountIndex };
  }
  return null;
};

const analysisAnchor = rows => {
  const candidates = [];
  rows.forEach((row, rowIndex) => rowCells(row).forEach((value, columnIndex) => {
    const normalized = normalizedText(value);
    if (/现金.*收支.*明细|现金收支明细/.test(normalized)) candidates.push({ rowIndex, columnIndex, title: textFor(value) });
  }));
  return candidates.find(candidate => headerNearAnchor(rows, candidate)) || null;
};

const emptySection = title => ({ title, items: [], declaredTotal: null, calculatedTotal: 0, total: 0, totalSourceRow: null });

export const parseCashFlowAnalysis = raw => {
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const anchor = analysisAnchor(rows);
  const source = emptySection('钱的来源'); const destination = emptySection('钱的去向');
  if (!anchor) return {
    mappingVersion: 1, sourceSheet: textFor(raw?.sourceSheet), analysisTitle: '', available: false, complete: false,
    source, destination, netAmount: 0, warnings: ['未识别到“累计现金收支明细”的项目表']
  };
  const header = headerNearAnchor(rows, anchor);
  let currentDirection = ''; let blankRows = 0; let destinationTotalSeen = false;
  for (let rowIndex = header.rowIndex + 1; rowIndex < Math.min(rows.length, header.rowIndex + 120); rowIndex += 1) {
    const cells = rowCells(rows[rowIndex]);
    const directionText = textFor(cells[header.directionIndex]); const label = textFor(cells[header.projectIndex]);
    const sourceAmount = cells[header.amountIndex]; const parsedAmount = amountFor(sourceAmount);
    if (!directionText && !label && parsedAmount === null) {
      blankRows += 1;
      if (destinationTotalSeen && blankRows >= 2) break;
      if (blankRows >= 5 && (source.items.length || destination.items.length)) break;
      continue;
    }
    blankRows = 0;
    const explicitDirection = directionFor(directionText); if (explicitDirection) currentDirection = explicitDirection;
    const totalRow = /^(?:合计|总计)$/.test(normalizedText(`${directionText}${label}`));
    if (totalRow && currentDirection) {
      const section = currentDirection === 'source' ? source : destination;
      section.declaredTotal = parsedAmount === null ? null : rounded(Math.abs(parsedAmount));
      section.totalSourceRow = sourceRowNumber(rows[rowIndex], rowIndex);
      if (currentDirection === 'destination') destinationTotalSeen = true;
      continue;
    }
    if (!currentDirection || !label) continue;
    const section = currentDirection === 'source' ? source : destination;
    section.items.push({
      key: keyFor(label, currentDirection), label, amount: rounded(Math.abs(parsedAmount ?? 0)), amountAvailable: parsedAmount !== null,
      sourceValue: textFor(sourceAmount), directionLabel: directionText, sourceRow: sourceRowNumber(rows[rowIndex], rowIndex),
      directionColumn: header.directionIndex + 1, itemColumn: header.projectIndex + 1, amountColumn: header.amountIndex + 1
    });
  }
  for (const section of [source, destination]) {
    section.calculatedTotal = rounded(section.items.reduce((sum, item) => sum + item.amount, 0));
    section.total = section.declaredTotal === null ? section.calculatedTotal : section.declaredTotal;
  }
  const available = source.items.length > 0 || destination.items.length > 0;
  const complete = source.items.length > 0 && destination.items.length > 0 && source.declaredTotal !== null && destination.declaredTotal !== null;
  return {
    mappingVersion: 1, sourceSheet: textFor(raw?.sourceSheet), analysisTitle: anchor.title, available, complete,
    source, destination, netAmount: rounded(source.total - destination.total),
    warnings: [
      ...(!source.items.length ? ['未识别到“钱的来源”项目'] : []),
      ...(!destination.items.length ? ['未识别到“钱的去向”项目'] : []),
      ...(source.items.length && source.declaredTotal === null ? ['“钱的来源”缺少合计行，当前使用逐项计算合计'] : []),
      ...(destination.items.length && destination.declaredTotal === null ? ['“钱的去向”缺少合计行，当前使用逐项计算合计'] : [])
    ]
  };
};
