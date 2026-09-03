const textFor = value => String(value ?? '').trim();

const normalizedText = value => textFor(value)
  .replace(/[\s\n\r\t【】\[\]（）()，,：:、·—–-]/g, '')
  .replace(/[的之]/g, '');

const hasValue = value => value !== null && value !== undefined && textFor(value) !== '';

const amountFor = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = textFor(value);
  if (!source || /^(?:[-—–]|无|不适用)$/.test(source)) return null;
  const negative = /^\(.+\)$/.test(source) || /^（.+）$/.test(source);
  const parsed = Number(source.replace(/[(),，（）￥¥元\s]/g, '').replace(/^[^-\d.]*/, ''));
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
};

const rounded = value => Number(Number(value || 0).toFixed(2));

const sourceMappings = [
  ['unpaid_cost', /(?:未付|应付).*(?:账款|款).*(?:成本)|(?:未付|应付)账款成本/],
  ['unpaid_commission', /(?:未付|应付).*(?:账款|款).*(?:佣金)|(?:未付|应付)账款佣金/],
  ['customer_advance', /预收款|预收账款|合同负债/],
  ['unpaid_wages', /未付工资|应付工资|应付职工薪酬/],
  ['investment_funds', /投资款|实收资本|股本/],
  ['agency_payable', /未付代付款|代付款|代付.*应付/],
  ['personal_income_tax', /未付税费.*个税|应交.*个税|个人所得税/],
  ['earned_profit', /赚(?:的)?钱|留存收益|未分配利润|本年利润/]
];

const destinationMappings = [
  ['bank_deposits', /银行存款|货币资金|现金及现金等价物/],
  ['receivables', /未收款|应收账款|应收款/],
  ['prepayments', /预付款|预付账款/],
  ['lease_deposit', /租赁保证金|租赁押金/],
  ['employee_social_insurance', /社会保险费.*员工个人|社保.*个人/],
  ['employee_housing_fund', /公积金.*员工个人|住房公积金.*个人/],
  ['fixed_assets', /固定资产/]
];

const keyFor = (label, side) => {
  const normalized = normalizedText(label);
  const mappings = side === 'source' ? sourceMappings : destinationMappings;
  return mappings.find(([, pattern]) => pattern.test(normalized))?.[0] || 'other';
};

const rowCells = row => Array.isArray(row) ? row : (Array.isArray(row?.cells) ? row.cells : []);
const sourceRowNumber = (row, index) => Number(row?.row) || index + 1;

const anchorCandidates = (rows, side) => {
  const titlePattern = side === 'source' ? /钱.*来源/ : /钱.*(?:去向|去处)/;
  const candidates = [];
  rows.forEach((row, rowIndex) => rowCells(row).forEach((value, columnIndex) => {
    if (titlePattern.test(normalizedText(value))) candidates.push({ rowIndex, columnIndex, title: textFor(value) });
  }));
  return candidates;
};

const headerNearAnchor = (rows, anchor) => {
  const lastRow = Math.min(rows.length - 1, anchor.rowIndex + 4);
  for (let rowIndex = anchor.rowIndex; rowIndex <= lastRow; rowIndex += 1) {
    const cells = rowCells(rows[rowIndex]);
    const start = Math.max(0, anchor.columnIndex - 1); const end = Math.min(cells.length - 1, anchor.columnIndex + 7);
    for (let projectIndex = start; projectIndex <= end; projectIndex += 1) {
      if (!/^项目$/.test(normalizedText(cells[projectIndex]))) continue;
      for (let amountIndex = projectIndex + 1; amountIndex <= Math.min(end, projectIndex + 5); amountIndex += 1) {
        if (/^金额$/.test(normalizedText(cells[amountIndex]))) return { rowIndex, projectIndex, amountIndex };
      }
    }
  }
  return null;
};

const parseTable = (rows, side) => {
  const candidates = anchorCandidates(rows, side);
  for (const anchor of candidates) {
    const header = headerNearAnchor(rows, anchor);
    if (!header) continue;
    const items = []; let declaredTotal = null; let totalSourceRow = null; let blankRows = 0;
    for (let rowIndex = header.rowIndex + 1; rowIndex < Math.min(rows.length, header.rowIndex + 45); rowIndex += 1) {
      const cells = rowCells(rows[rowIndex]); const label = textFor(cells[header.projectIndex]); const sourceAmount = cells[header.amountIndex]; const amount = amountFor(sourceAmount);
      if (!label && amount === null) { blankRows += 1; if (blankRows >= 3 && items.length) break; continue; }
      blankRows = 0;
      if (/^(?:合计|总计)$/.test(normalizedText(label))) { declaredTotal = amount; totalSourceRow = sourceRowNumber(rows[rowIndex], rowIndex); break; }
      if (!label) continue;
      items.push({ key: keyFor(label, side), label, amount: rounded(amount ?? 0), amountAvailable: amount !== null, sourceValue: textFor(sourceAmount), sourceRow: sourceRowNumber(rows[rowIndex], rowIndex), sourceColumn: header.projectIndex + 1, amountColumn: header.amountIndex + 1 });
    }
    if (!items.length && declaredTotal === null) continue;
    const calculatedTotal = rounded(items.reduce((sum, item) => sum + item.amount, 0));
    return { title: anchor.title, headerRow: sourceRowNumber(rows[header.rowIndex], header.rowIndex), itemColumn: header.projectIndex + 1, amountColumn: header.amountIndex + 1, totalSourceRow, items, declaredTotal: declaredTotal === null ? null : rounded(declaredTotal), calculatedTotal, total: declaredTotal === null ? calculatedTotal : rounded(declaredTotal) };
  }
  return { title: '', headerRow: null, itemColumn: null, amountColumn: null, totalSourceRow: null, items: [], declaredTotal: null, calculatedTotal: 0, total: 0 };
};

export const parseAssetLiabilityAnalysis = raw => {
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const source = parseTable(rows, 'source'); const destination = parseTable(rows, 'destination');
  const available = source.items.length > 0 || destination.items.length > 0;
  const complete = source.items.length > 0 && destination.items.length > 0 && source.declaredTotal !== null && destination.declaredTotal !== null;
  const difference = rounded(source.total - destination.total);
  return {
    mappingVersion: 1,
    sourceSheet: textFor(raw?.sourceSheet),
    available,
    complete,
    source,
    destination,
    difference,
    balanced: complete && Math.abs(difference) <= 0.01,
    warnings: [
      ...(!source.items.length ? ['未识别到“钱的来源”项目表'] : []),
      ...(!destination.items.length ? ['未识别到“钱的去向”项目表'] : []),
      ...(source.items.length && source.declaredTotal === null ? ['“钱的来源”缺少合计行，当前使用逐项计算合计'] : []),
      ...(destination.items.length && destination.declaredTotal === null ? ['“钱的去向”缺少合计行，当前使用逐项计算合计'] : []),
      ...(complete && Math.abs(difference) > 0.01 ? [`来源与去向相差 ${difference.toFixed(2)} 元，请复核源表`] : [])
    ]
  };
};
