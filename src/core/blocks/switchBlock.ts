import { OPERATORS, OPERATOR_OPTIONS, describeClause, testClause } from '../condition';
import { ERROR_PORT, routeTo } from '../ports';
import type { BlockDefinition, ConfigProblem, Row } from '../types';

/** One case of a Switch: the output it sends to, and the comparison against the switch value. */
export interface SwitchCase {
  /** Output (port) name; also the branch key in scripts. */
  port: string;
  operator: string;
  /** Compared to the switch value (templated). Ignored by "is empty" and similar. */
  value: string;
}

/** Switch settings: the value to look at, cases checked in order, and the `default` output for no match. */
export interface SwitchConfig {
  value: string;
  cases: SwitchCase[];
}

/** Output taken when no case matches. Always present, always last. */
export const SWITCH_DEFAULT_PORT = 'default';

/** A valid case name: starts with a letter or `_`, then letters, digits, `_` or `-` (a script branch key). */
const PORT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;

/**
 * Names a case cannot take: the default and error outputs, other blocks' continue ports (`out`, `done`:
 * a Switch has none, it rejoins like If) and the keys a script step uses itself.
 */
export const RESERVED_CASE_NAMES: ReadonlySet<string> = new Set([SWITCH_DEFAULT_PORT, ERROR_PORT, 'out', 'done', 'id', 'step', 'onError', 'switch']);

/** Why a case name is not usable, or null. */
function nameProblem(name: string): string | null {
  if (!name) return 'has no output name';
  if (!PORT_NAME.test(name)) return `output name "${name}" must start with a letter and use only letters, digits, "_" and "-" (at most 40)`;
  if (RESERVED_CASE_NAMES.has(name)) return `output name "${name}" is reserved`;
  return null;
}

function caseRows(config: Partial<SwitchConfig>): Row[] {
  if (!Array.isArray(config.cases)) return [];
  return (config.cases as unknown[]).filter((row): row is Row => typeof row === 'object' && row !== null);
}

/**
 * The output of each case row, in row order (index i is row i). A row whose name is empty, invalid,
 * reserved or already taken gets the stand-in `case<N>` (N = row number), so the row keeps an output
 * (and its connections) while its name is being typed; check and validate report the bad name.
 */
export function casePorts(config: Partial<SwitchConfig>): string[] {
  const names = caseRows(config).map((row) => String(row.port ?? '').trim());
  // Valid names claim theirs first (the first row wins a duplicate), so a stand-in never takes one.
  const claimed = new Set(names.filter((name, index) => !nameProblem(name) && names.indexOf(name) === index));
  const taken = new Set<string>();
  return names.map((name, index) => {
    if (claimed.has(name) && !taken.has(name)) {
      taken.add(name);
      return name;
    }
    let stand = `case${index + 1}`;
    for (let n = 2; claimed.has(stand) || taken.has(stand); n += 1) stand = `case${index + 1}_${n}`;
    taken.add(stand);
    return stand;
  });
}

/** Switch: sends the data out of the first case whose condition holds, or out of "default". */
export const switchBlock: BlockDefinition<SwitchConfig> = {
  type: 'switch',
  label: 'Switch',
  description: 'Go one of several ways: the first case that matches the value picks the output, else "default".',
  icon: '🚦',
  accent: '#64748b',
  ports: (config) => [...casePorts(config), SWITCH_DEFAULT_PORT],
  defaultConfig: {
    value: '{{value}}',
    cases: [
      { port: 'first', operator: 'equals', value: '1' },
      { port: 'second', operator: 'equals', value: '2' },
    ],
  },
  fields: [
    { key: 'value', label: 'Value', kind: 'text', templated: true, placeholder: '{{status}}', help: 'What the cases look at.' },
    {
      key: 'cases',
      label: 'Cases (first match wins)',
      kind: 'rows',
      required: true,
      columns: [
        { key: 'port', label: 'Output', placeholder: 'ok' },
        { key: 'operator', label: 'Condition', options: OPERATOR_OPTIONS },
        { key: 'value', label: 'Compare to', templated: true, placeholder: '200' },
      ],
      help: 'Each case is an output named after it (letters, digits, "_" and "-"; not "default", "error", "out" or "done"). No match goes to "default". For a pattern, write /text/i.',
    },
  ],
  summary: (config) => {
    const names = caseRows(config).map((row) => String(row.port ?? '').trim() || '?');
    return `${config.value}: ${[...names, SWITCH_DEFAULT_PORT].join(' / ')}`;
  },
  outputs: [{ key: '(same data)', description: 'The input, unchanged, out of the matching case or "default".' }],

  validate(config) {
    const problems: ConfigProblem[] = [];
    const seen = new Set<string>();
    caseRows(config).forEach((row, index) => {
      const name = String(row.port ?? '').trim();
      const operator = String(row.operator ?? '');
      const problem = nameProblem(name);
      if (problem) problems.push({ key: 'cases', code: name ? 'config.value' : 'config.required', message: `Case ${index + 1} ${problem}` });
      else if (seen.has(name)) problems.push({ key: 'cases', code: 'config.value', message: `Case ${index + 1}: output name "${name}" is used twice` });
      seen.add(name);
      if (!OPERATORS.some((op) => op.value === operator)) {
        problems.push({
          key: 'cases',
          code: 'config.value',
          message: `Case ${index + 1} has an unknown condition "${operator}" (one of: ${OPERATORS.map((op) => op.value).join(', ')})`,
        });
      }
    });
    return problems;
  },

  async run(ctx, input) {
    const ports = casePorts(ctx.config);
    const rows = caseRows(ctx.config);
    for (const [index, row] of rows.entries()) {
      const clause = { left: ctx.config.value, operator: String(row.operator ?? ''), right: String(row.value ?? '') };
      if (testClause(clause)) {
        const port = ports[index] as string;
        ctx.log('info', `Case "${port}": ${describeClause(clause)}`);
        return routeTo(port, input);
      }
    }
    ctx.log('info', `No case matched "${ctx.config.value}": default`);
    return routeTo(SWITCH_DEFAULT_PORT, input);
  },
};
