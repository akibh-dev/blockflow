/**
 * Comparisons shared by If (and later Assert, Wait For, Loop until, Filter).
 * Operands are plain strings, already rendered from templates.
 */

export interface Clause {
  left: string;
  operator: string;
  right: string;
}

export interface Condition {
  /** all = every clause must hold (AND); any = at least one (OR). */
  match: 'all' | 'any';
  clauses: Clause[];
}

interface Operator {
  value: string;
  label: string;
  /** False for operators that ignore the right-hand side. */
  usesRight: boolean;
  test(left: string, right: string): boolean;
}

/** "1,250" → 1250, "$9.99" → 9.99, "" → null. */
export function parseNumber(text: string): number | null {
  const cleaned = text.trim().replace(/[,\s]/g, '').replace(/^[^\d+\-.]+/, '').replace(/[^\d.]+$/, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function numbers(left: string, right: string, compare: (a: number, b: number) => boolean): boolean {
  const a = parseNumber(left);
  const b = parseNumber(right);
  return a !== null && b !== null && compare(a, b);
}

function matches(left: string, pattern: string): boolean {
  const literal = /^\/(.*)\/([dgimsuyv]*)$/s.exec(pattern);
  try {
    return literal ? new RegExp(literal[1] ?? '', literal[2]).test(left) : new RegExp(pattern).test(left);
  } catch {
    throw new Error(`Invalid pattern: ${pattern}`);
  }
}

const TRUTHY = new Set(['true', 'yes', 'on', '1']);

export const OPERATORS: Operator[] = [
  { value: 'equals', label: 'equals', usesRight: true, test: (l, r) => l === r },
  { value: 'not-equals', label: 'does not equal', usesRight: true, test: (l, r) => l !== r },
  { value: 'contains', label: 'contains', usesRight: true, test: (l, r) => l.includes(r) },
  { value: 'not-contains', label: 'does not contain', usesRight: true, test: (l, r) => !l.includes(r) },
  { value: 'starts-with', label: 'starts with', usesRight: true, test: (l, r) => l.startsWith(r) },
  { value: 'ends-with', label: 'ends with', usesRight: true, test: (l, r) => l.endsWith(r) },
  { value: 'matches', label: 'matches pattern (regex)', usesRight: true, test: matches },
  { value: 'greater', label: 'is greater than (numbers)', usesRight: true, test: (l, r) => numbers(l, r, (a, b) => a > b) },
  { value: 'greater-equal', label: 'is at least (numbers)', usesRight: true, test: (l, r) => numbers(l, r, (a, b) => a >= b) },
  { value: 'less', label: 'is less than (numbers)', usesRight: true, test: (l, r) => numbers(l, r, (a, b) => a < b) },
  { value: 'less-equal', label: 'is at most (numbers)', usesRight: true, test: (l, r) => numbers(l, r, (a, b) => a <= b) },
  { value: 'empty', label: 'is empty', usesRight: false, test: (l) => l.trim() === '' },
  { value: 'not-empty', label: 'is not empty', usesRight: false, test: (l) => l.trim() !== '' },
  { value: 'true', label: 'is true (true / yes / on / 1)', usesRight: false, test: (l) => TRUTHY.has(l.trim().toLowerCase()) },
  { value: 'false', label: 'is false', usesRight: false, test: (l) => !TRUTHY.has(l.trim().toLowerCase()) },
];

export const OPERATOR_OPTIONS = OPERATORS.map(({ value, label }) => ({ value, label }));

export function operatorLabel(value: string): string {
  return OPERATORS.find((op) => op.value === value)?.label ?? value;
}

/** Throws for an unknown operator or an invalid regex, so the step fails with a clear message. */
export function testClause({ left, operator, right }: Clause): boolean {
  const op = OPERATORS.find((candidate) => candidate.value === operator);
  if (!op) throw new Error(`Unknown condition "${operator}"`);
  return op.test(left, right);
}

export function testCondition(condition: Condition): boolean {
  if (condition.clauses.length === 0) return true;
  return condition.match === 'any'
    ? condition.clauses.some(testClause)
    : condition.clauses.every(testClause);
}

export function describeClause({ left, operator, right }: Clause): string {
  const op = OPERATORS.find((candidate) => candidate.value === operator);
  return [left, operatorLabel(operator), op?.usesRight === false ? '' : right].filter(Boolean).join(' ');
}
