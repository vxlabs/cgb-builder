import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { GrammarKey } from '../tree-sitter-engine.js';
import { splitIdentifier, oneLine, nodeRange, leadingDocComment } from '../utils.js';
import type { SyntaxNode } from 'web-tree-sitter';

async function root(src: string, lang: GrammarKey): Promise<SyntaxNode> {
  return (await treeSitterEngine.parse(src, lang)).rootNode;
}

describe('splitIdentifier', () => {
  it.each([
    ['parseFileAsync', 'parse file async'],
    ['HTTPServer_v2', 'http server v 2'],
    ['snake_case_name', 'snake case name'],
    ['kebab-case', 'kebab case'],
    ['XMLHttpRequest', 'xml http request'],
    ['a', 'a'],
    ['', ''],
    ['__init__', 'init'],
    ['getHTTP2Response', 'get http 2 response'],
  ])('%s -> %s', (input, expected) => {
    expect(splitIdentifier(input)).toBe(expected);
  });
});

describe('oneLine', () => {
  it('collapses whitespace and trims', () => {
    expect(oneLine('  a \n\t b   c ')).toBe('a b c');
  });
  it('truncates with an ellipsis within max', () => {
    const r = oneLine('x'.repeat(300), 50);
    expect(r).toHaveLength(50);
    expect(r.endsWith('…')).toBe(true);
  });
  it('leaves short text alone', () => {
    expect(oneLine('short', 10)).toBe('short');
  });
});

describe('nodeRange / leadingDocComment', () => {
  it('nodeRange is 1-based inclusive', async () => {
    const r = await root('\n\nfunction f() {\n  return 1;\n}\n', 'typescript');
    const fn = r.descendantsOfType('function_declaration')[0];
    expect(nodeRange(fn)).toEqual({ startLine: 3, endLine: 5 });
  });

  it('jsdoc: first paragraph, strips tags, handles export parent, rejects gaps', async () => {
    const src = `/**
 * Finds a user
 * by id.
 *
 * More detail here.
 * @param id the id
 */
export function find(id: string) {}

// not a doc
function plain() {}

/** Detached */

function gap() {}
`;
    const r = await root(src, 'typescript');
    const fns = r.descendantsOfType('function_declaration');
    expect(leadingDocComment(fns[0], src, 'jsdoc')).toBe('Finds a user by id.');
    expect(leadingDocComment(fns[1], src, 'jsdoc')).toBeUndefined();
    expect(leadingDocComment(fns[2], src, 'jsdoc')).toBeUndefined();
  });

  it('python: docstring', async () => {
    const src = `def f():
    """Do the thing.

    Details.
    """
    return 1

def g():
    return 2
`;
    const r = await root(src, 'python');
    const fns = r.descendantsOfType('function_definition');
    expect(leadingDocComment(fns[0], src, 'python')).toBe('Do the thing.');
    expect(leadingDocComment(fns[1], src, 'python')).toBeUndefined();
  });

  it('hash: consecutive # lines', async () => {
    const src = `# Helper that adds.
# Second line.
def add(a, b):
    return a + b
`;
    const r = await root(src, 'python');
    const fn = r.descendantsOfType('function_definition')[0];
    expect(leadingDocComment(fn, src, 'hash')).toBe('Helper that adds. Second line.');
  });

  it('slash: C# /// xml docs', async () => {
    const src = `class C {
    /// <summary>
    /// Adds numbers.
    /// </summary>
    public int Add(int a, int b) { return a + b; }

    public int NoDoc() { return 0; }
}
`;
    const r = await root(src, 'csharp');
    const ms = r.descendantsOfType('method_declaration');
    expect(leadingDocComment(ms[0], src, 'slash')).toBe('Adds numbers.');
    expect(leadingDocComment(ms[1], src, 'slash')).toBeUndefined();
  });
});
