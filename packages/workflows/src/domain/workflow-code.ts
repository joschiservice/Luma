/**
 * The `workflow/2` code view: a TypeScript module that passes one literal to `defineWorkflow`.
 * Code Step sources print as `code` template literals so they stay readable. Parsing reads only
 * literals; it never evaluates source, imports or expressions.
 */

type Literal =
  null | boolean | number | string | Literal[] | { [key: string]: Literal };

const prefix = 'export default defineWorkflow(';

const identifier = /^[A-Za-z_$][\w$]*$/;

const escapes: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function quote(value: string) {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result +=
      escapes[character] ??
      (code < 0x20 || code === 0x2028 || code === 0x2029
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character);
  }

  return `'${result}'`;
}

function template(value: string) {
  return `code\`\n${value.replace(/\\|`|\$\{/g, (match) => `\\${match}`)}\n\``;
}

function print(value: unknown, indent: string, key?: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Numbers must be finite');

    return JSON.stringify(value);
  }
  if (typeof value === 'string')
    return key === 'source' && value.includes('\n')
      ? template(value)
      : quote(value);
  const inner = `${indent}  `;
  if (Array.isArray(value))
    return value.length
      ? `[\n${value.map((item) => `${inner}${print(item, inner)},\n`).join('')}${indent}]`
      : '[]';
  if (typeof value === 'object') {
    const entries = Object.entries(value);

    return entries.length
      ? `{\n${entries
          .map(
            ([name, item]) =>
              `${inner}${identifier.test(name) ? name : quote(name)}: ${print(item, inner, name)},\n`,
          )
          .join('')}${indent}}`
      : '{}';
  }
  throw new Error('Only JSON values can be printed');
}

/** Prints draft content as the canonical code view. The same content always prints the same text. */
export function printWorkflowSource(content: unknown): string {
  return `${prefix}${print(content, '')});\n`;
}

/** A problem in code view text, with a 1-based line and column. */
export class WorkflowCodeError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'WorkflowCodeError';
  }
}

/** Reads the literal passed to `defineWorkflow`. Comments and formatting are allowed; code is not. */
export function parseWorkflowSource(code: string): Literal {
  let position = 0;

  function fail(message: string, at = position): never {
    const before = code.slice(0, at).split('\n');
    throw new WorkflowCodeError(
      message,
      before.length,
      before.at(-1)!.length + 1,
    );
  }

  function skip() {
    while (position < code.length) {
      if (/\s/.test(code[position]!)) position++;
      else if (code.startsWith('//', position)) {
        const end = code.indexOf('\n', position);
        position = end === -1 ? code.length : end + 1;
      } else if (code.startsWith('/*', position)) {
        const end = code.indexOf('*/', position + 2);
        if (end === -1) fail('Close this comment with */.');
        position = end + 2;
      } else return;
    }
  }

  function expect(text: string, message: string) {
    skip();
    if (!code.startsWith(text, position)) fail(message);
    position += text.length;
  }

  function quoted(): string {
    const delimiter = code[position]!;
    const start = position++;
    let result = '';
    while (position < code.length) {
      const character = code[position++]!;
      if (character === delimiter) return result;
      if (character === '\n') fail('Close this text with a quote.', start);
      if (character !== '\\') {
        result += character;
        continue;
      }
      const escape = code[position++];
      const simple: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
        '\\': '\\',
        "'": "'",
        '"': '"',
        '\n': '',
      };
      if (escape !== undefined && Object.hasOwn(simple, escape))
        result += simple[escape];
      else if (
        escape === 'u' &&
        /^[0-9a-fA-F]{4}$/.test(code.slice(position, position + 4))
      ) {
        result += String.fromCharCode(
          Number.parseInt(code.slice(position, position + 4), 16),
        );
        position += 4;
      } else
        fail('Use a supported escape such as \\n or \\u0041.', position - 2);
    }
    fail('Close this text with a quote.', start);
  }

  function templateLiteral(tagged: boolean): string {
    const start = position++;
    let result = '';
    while (position < code.length) {
      const character = code[position++]!;
      if (character === '`') {
        if (tagged) {
          if (!result.startsWith('\n') || !result.endsWith('\n'))
            fail('Start and end Code Step source on its own line.', start);
          result = result.slice(1, -1);
        }

        return result;
      }
      if (character === '$' && code[position] === '{')
        fail('Expressions such as ${…} are not supported.', position - 1);
      if (character === '\\') {
        const escape = code[position++];
        if (escape === '\\' || escape === '`') result += escape;
        else if (escape === '$' && code[position] === '{') {
          result += '${';
          position++;
        } else
          fail('Escape only \\, ` and ${ in Code Step source.', position - 2);
        continue;
      }
      result += character;
    }
    fail('Close this Code Step source with a backtick.', start);
  }

  function value(): Literal {
    skip();
    const character = code[position];
    if (character === '{') return object();
    if (character === '[') return array();
    if (character === "'" || character === '"') return quoted();
    if (character === '`') return templateLiteral(false);
    if (code.startsWith('code`', position)) {
      position += 4;

      return templateLiteral(true);
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      code.slice(position),
    );
    if (number) {
      position += number[0].length;

      return Number(number[0]);
    }
    for (const [word, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (
        code.startsWith(word, position) &&
        !/[\w$]/.test(code[position + word.length] ?? '')
      ) {
        position += word.length;

        return literal;
      }
    }

    return fail(
      'Only literal values are supported here: text, numbers, true, false, null, lists and objects.',
    );
  }

  function array(): Literal[] {
    position++;
    const items: Literal[] = [];
    for (;;) {
      skip();
      if (code[position] === ']') {
        position++;

        return items;
      }
      items.push(value());
      skip();
      if (code[position] === ',') position++;
      else if (code[position] !== ']') fail('Separate list items with commas.');
    }
  }

  function object(): Record<string, Literal> {
    position++;
    const result: Record<string, Literal> = {};
    for (;;) {
      skip();
      if (code[position] === '}') {
        position++;

        return result;
      }
      const start = position;
      let name: string;
      if (code[position] === "'" || code[position] === '"') name = quoted();
      else {
        const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(position));
        if (!match) fail('Use a name or quoted text as the property name.');
        name = match[0];
        position += name.length;
      }
      if (Object.hasOwn(result, name))
        fail(`“${name}” appears twice. Remove one of them.`, start);
      expect(':', `Add a colon after “${name}”.`);
      result[name] = value();
      skip();
      if (code[position] === ',') position++;
      else if (code[position] !== '}') fail('Separate properties with commas.');
    }
  }

  for (const word of ['export', 'default', 'defineWorkflow', '('])
    expect(word, 'Start with export default defineWorkflow(…).');
  const result = value();
  expect(')', 'Close defineWorkflow( with a parenthesis.');
  skip();
  if (code[position] === ';') position++;
  skip();
  if (position !== code.length)
    fail('Remove everything after defineWorkflow(…);');

  return result;
}
