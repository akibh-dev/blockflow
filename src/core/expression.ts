/**
 * A small, safe expression language for templates (`{{ price * 1.1 }}`) and the Transform and
 * Filter blocks. Parsed and interpreted here: no `eval` / `new Function` (forbidden in MV3
 * extensions, and unsafe). Only own properties of the data are reachable.
 *
 *   values      12  3.5  'text'  "text"  true  false  null  [1, 2]
 *   data        price  item.title  rows[0].name  $json.x  items[index]
 *   math        + - * / %   (+ joins text when either side is text)
 *   compare     == != < <= > >=   (=== and !== work too)
 *   logic       && || !   a ? b : c   a ?? b
 *   functions   upper(x) lower(x) trim(x) len(x) number(x) string(x) round(x, 2) floor ceil abs
 *               min(a, b…) max(…) sum(list) avg(list) count(list) join(list, ', ') split(text, ',')
 *               replace(text, find, with) contains(a, b) startsWith endsWith slice(x, from, to)
 *               first(list) last(list) keys(obj) values(obj) pluck(list, 'key') unique(list)
 *               sort(list, 'key'?) reverse(list) json(x) parseJson(text) now() today()
 *               default(x, fallback) matches(text, '/re/i') extract(text, '/re(group)/')
 */

export class ExpressionError extends Error {}

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'id'; value: string }
  | { type: 'op'; value: string };

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', '[', ']', ',', '.'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(source[i + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j += 1) {
        if (source[j] === '\\' && j + 1 < source.length) {
          j += 1;
          const escaped = source[j] as string;
          // Only \n \t \\ \' \" are escapes; anything else keeps its backslash, so regexes like
          // '/#(\d+)/' can be typed as they are.
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : /['"\\]/.test(escaped) ? escaped : `\\${escaped}`;
        } else value += source[j];
      }
      if (j >= source.length) throw new ExpressionError(`Unclosed text in: ${source}`);
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ type: 'id', value: match[0] });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`Unexpected "${char}" in: ${source}`);
    tokens.push({ type: 'op', value: op });
    i += op.length;
  }
  return tokens;
}

type Node =
  | { kind: 'lit'; value: unknown }
  | { kind: 'id'; name: string }
  | { kind: 'member'; object: Node; property: Node }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'unary'; op: string; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'cond'; test: Node; then: Node; else: Node }
  | { kind: 'array'; items: Node[] };

const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

class Parser {
  private index = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  parse(): Node {
    const node = this.conditional();
    if (this.index < this.tokens.length) throw this.error('Unexpected');
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.type === 'op' && token.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw this.error(`Expected "${value}"`);
    this.index += 1;
  }

  private error(message: string): ExpressionError {
    const token = this.peek();
    return new ExpressionError(`${message}${token ? ` "${String(token.value)}"` : ' end'} in: ${this.source}`);
  }

  private conditional(): Node {
    const test = this.binary(0);
    if (!this.isOp('?')) return test;
    this.index += 1;
    const then = this.conditional();
    this.expect(':');
    return { kind: 'cond', test, then, else: this.conditional() };
  }

  private binary(minPrecedence: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const precedence = token?.type === 'op' ? PRECEDENCE[token.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index += 1;
      const right = this.binary(precedence + 1);
      left = { kind: 'binary', op: (token as Token & { value: string }).value, left, right };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp('!') || this.isOp('-')) {
      const op = (this.peek() as Token & { value: string }).value;
      this.index += 1;
      return { kind: 'unary', op, arg: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.index += 1;
        const token = this.peek();
        if (token?.type !== 'id') throw this.error('Expected a name after "."');
        this.index += 1;
        node = { kind: 'member', object: node, property: { kind: 'lit', value: token.value } };
      } else if (this.isOp('[')) {
        this.index += 1;
        const property = this.conditional();
        this.expect(']');
        node = { kind: 'member', object: node, property };
      } else return node;
    }
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw this.error('Unexpected');
    this.index += 1;
    if (token.type === 'num' || token.type === 'str') return { kind: 'lit', value: token.value };
    if (token.type === 'id') {
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      if (this.isOp('(')) {
        this.index += 1;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          do {
            if (args.length > 0) this.index += 1;
            args.push(this.conditional());
          } while (this.isOp(','));
        }
        this.expect(')');
        if (!(token.value in FUNCTIONS)) throw new ExpressionError(`Unknown function ${token.value}() in: ${this.source}`);
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'id', name: token.value };
    }
    if (token.value === '(') {
      const inner = this.conditional();
      this.expect(')');
      return inner;
    }
    if (token.value === '[') {
      const items: Node[] = [];
      if (!this.isOp(']')) {
        do {
          if (items.length > 0) this.index += 1;
          items.push(this.conditional());
        } while (this.isOp(','));
      }
      this.expect(']');
      return { kind: 'array', items };
    }
    this.index -= 1;
    throw this.error('Unexpected');
  }
}

// --- helpers ------------------------------------------------------------------

function own(object: unknown, key: unknown): unknown {
  if (object === null || object === undefined) return undefined;
  if (typeof object === 'string' && key === 'length') return object.length;
  if (Array.isArray(object) && key === 'length') return object.length;
  if (typeof object !== 'object' && typeof object !== 'string') return undefined;
  const name = String(key);
  return Object.prototype.hasOwnProperty.call(object, name) ? (object as Record<string, unknown>)[name] : undefined;
}

/** Text to number like a person reads it: "1,250" → 1250, "$9.99" → 9.99. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return Number.NaN;
  const cleaned = value.trim().replace(/[,\s]/g, '').replace(/^[^\d+\-.]+/, '').replace(/[^\d.]+$/, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function regex(pattern: string): RegExp {
  const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(pattern);
  try {
    return literal ? new RegExp(literal[1] as string, literal[2]) : new RegExp(pattern);
  } catch {
    throw new ExpressionError(`Invalid pattern: ${pattern}`);
  }
}

function compareValues(a: unknown, b: unknown): number {
  const x = toNumber(a);
  const y = toNumber(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return toText(a).localeCompare(toText(b));
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  upper: (x) => toText(x).toUpperCase(),
  lower: (x) => toText(x).toLowerCase(),
  trim: (x) => toText(x).replace(/\s+/g, ' ').trim(),
  len: (x) => (Array.isArray(x) ? x.length : typeof x === 'object' && x ? Object.keys(x).length : toText(x).length),
  number: (x) => toNumber(x),
  string: (x) => toText(x),
  round: (x, digits = 0) => {
    const factor = 10 ** toNumber(digits);
    return Math.round(toNumber(x) * factor) / factor;
  },
  floor: (x) => Math.floor(toNumber(x)),
  ceil: (x) => Math.ceil(toNumber(x)),
  abs: (x) => Math.abs(toNumber(x)),
  min: (...args) => Math.min(...args.flatMap(list).map(toNumber)),
  max: (...args) => Math.max(...args.flatMap(list).map(toNumber)),
  sum: (x) => list(x).reduce<number>((total, item) => total + (toNumber(item) || 0), 0),
  avg: (x) => {
    const items = list(x);
    return items.length === 0 ? 0 : items.reduce<number>((total, item) => total + (toNumber(item) || 0), 0) / items.length;
  },
  count: (x) => list(x).length,
  join: (x, separator = ', ') => list(x).map(toText).join(toText(separator)),
  split: (x, separator = ',') => toText(x).split(toText(separator)).map((part) => part.trim()),
  replace: (x, find, replacement = '') => {
    const pattern = toText(find);
    if (!/^\/[\s\S]*\/[a-z]*$/.test(pattern)) return toText(x).split(pattern).join(toText(replacement));
    const re = regex(pattern);
    return toText(x).replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), toText(replacement));
  },
  contains: (x, part) => (Array.isArray(x) ? x.some((item) => toText(item) === toText(part)) : toText(x).toLowerCase().includes(toText(part).toLowerCase())),
  startsWith: (x, part) => toText(x).startsWith(toText(part)),
  endsWith: (x, part) => toText(x).endsWith(toText(part)),
  slice: (x, from = 0, to) => (Array.isArray(x) ? x.slice(toNumber(from), to === undefined ? undefined : toNumber(to)) : toText(x).slice(toNumber(from), to === undefined ? undefined : toNumber(to))),
  first: (x) => list(x)[0],
  last: (x) => list(x).at(-1),
  keys: (x) => (x && typeof x === 'object' ? Object.keys(x) : []),
  values: (x) => (x && typeof x === 'object' ? Object.values(x) : []),
  pluck: (x, key) => list(x).map((item) => own(item, toText(key))),
  unique: (x) => [...new Map(list(x).map((item) => [toText(item), item])).values()],
  sort: (x, key) => [...list(x)].sort((a, b) => (key === undefined ? compareValues(a, b) : compareValues(own(a, toText(key)), own(b, toText(key))))),
  reverse: (x) => [...list(x)].reverse(),
  json: (x) => toText(x),
  parseJson: (x) => {
    try {
      return JSON.parse(toText(x));
    } catch {
      throw new ExpressionError('parseJson: not valid JSON');
    }
  },
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  default: (x, fallback) => (x === undefined || x === null || x === '' ? fallback : x),
  matches: (x, pattern) => regex(toText(pattern)).test(toText(x)),
  extract: (x, pattern) => {
    const found = regex(toText(pattern)).exec(toText(x));
    return found ? (found[1] ?? found[0]) : '';
  },
};

function evaluateNode(node: Node, scope: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'array':
      return node.items.map((item) => evaluateNode(item, scope));
    case 'id':
      return node.name === '$json' ? scope : own(scope, node.name);
    case 'member':
      return own(evaluateNode(node.object, scope), evaluateNode(node.property, scope));
    case 'call':
      return (FUNCTIONS[node.name] as (...args: unknown[]) => unknown)(...node.args.map((arg) => evaluateNode(arg, scope)));
    case 'unary': {
      const value = evaluateNode(node.arg, scope);
      return node.op === '!' ? !truthy(value) : -toNumber(value);
    }
    case 'cond':
      return truthy(evaluateNode(node.test, scope)) ? evaluateNode(node.then, scope) : evaluateNode(node.else, scope);
    case 'binary': {
      if (node.op === '&&') {
        const left = evaluateNode(node.left, scope);
        return truthy(left) ? evaluateNode(node.right, scope) : left;
      }
      if (node.op === '||') {
        const left = evaluateNode(node.left, scope);
        return truthy(left) ? left : evaluateNode(node.right, scope);
      }
      if (node.op === '??') {
        const left = evaluateNode(node.left, scope);
        return left === undefined || left === null ? evaluateNode(node.right, scope) : left;
      }
      const a = evaluateNode(node.left, scope);
      const b = evaluateNode(node.right, scope);
      switch (node.op) {
        case '+': {
          // Adds when both sides read as numbers ("1,250" + 10 → 1260), otherwise joins text.
          const x = toNumber(a);
          const y = toNumber(b);
          return !Number.isNaN(x) && !Number.isNaN(y) ? x + y : toText(a) + toText(b);
        }
        case '-':
          return toNumber(a) - toNumber(b);
        case '*':
          return toNumber(a) * toNumber(b);
        case '/':
          return toNumber(a) / toNumber(b);
        case '%':
          return toNumber(a) % toNumber(b);
        case '==':
        case '===':
          return toText(a) === toText(b);
        case '!=':
        case '!==':
          return toText(a) !== toText(b);
        case '<':
          return compareValues(a, b) < 0;
        case '<=':
          return compareValues(a, b) <= 0;
        case '>':
          return compareValues(a, b) > 0;
        case '>=':
          return compareValues(a, b) >= 0;
      }
      throw new ExpressionError(`Unknown operator ${node.op}`);
    }
  }
}

const cache = new Map<string, Node>();

/** Parses (cached) and checks an expression; throws ExpressionError with a readable message. */
export function parseExpression(source: string): Node {
  const key = source.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  if (!key) throw new ExpressionError('Empty expression');
  const node = new Parser(tokenize(key), key).parse();
  if (cache.size > 500) cache.clear();
  cache.set(key, node);
  return node;
}

export function evaluate(source: string, scope: Record<string, unknown>): unknown {
  return evaluateNode(parseExpression(source), scope);
}
