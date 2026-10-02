/* eslint-disable no-useless-escape -- PHP namespace fixtures contain literal backslashes */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSnippet, type ParsedView } from './helpers.js';
import type { LanguageAdapter } from '../adapter.js';
import { CSharpAdapter } from '../adapters/csharp.js';
import { PythonAdapter } from '../adapters/python.js';
import { GoAdapter } from '../adapters/go.js';
import { JavaAdapter } from '../adapters/java.js';
import { RustAdapter } from '../adapters/rust.js';
import { RubyAdapter } from '../adapters/ruby.js';
import { PhpAdapter } from '../adapters/php.js';
import { CAdapter } from '../adapters/c.js';
import { KotlinAdapter } from '../adapters/kotlin.js';

jest.setTimeout(30000);

const SNIPPETS: Record<string, [LanguageAdapter, string, string]> = {
  python: [
    new PythonAdapter(),
    'src/a.py',
    `import os
from .util import helper
from . import sibling

class Base:
    pass

class Greeter(Base):
    def __init__(self, name):
        self.name = name

    def greet(self):
        return helper(self.name)

def run():
    g = Greeter("x")
    g.greet()
    return os.getcwd()
`,
  ],
  go: [
    new GoAdapter(),
    'src/a.go',
    `package main

import (
	"fmt"
	"example.com/proj/internal/util"
)

type Greeter struct {
	Name string
}

type Speaker interface {
	Speak() string
}

func (g *Greeter) Greet() string {
	return util.Helper(g.Name)
}

func (g *Greeter) Speak() string {
	return g.Greet()
}

func run() {
	g := &Greeter{Name: "x"}
	fmt.Println(g.Greet())
}
`,
  ],

  java: [
    new JavaAdapter(),
    'src/A.java',
    `package app;

import java.util.List;
import app.util.Helper;

interface Speaker {
    String speak();
}

class Base {}

public class Greeter extends Base implements Speaker {
    private String name;

    public String speak() {
        return greet();
    }

    public String greet() {
        return Helper.help(name);
    }
}

class Runner {
    void run() {
        Greeter g = new Greeter();
        g.greet();
    }
}
`,
  ],
  rust: [
    new RustAdapter(),
    'src/a.rs',
    `use std::collections::HashMap;
use crate::util::helper;

trait Speaker {
    fn speak(&self) -> String;
}

struct Greeter {
    name: String,
}

impl Greeter {
    fn greet(&self) -> String {
        helper(&self.name)
    }
}

impl Speaker for Greeter {
    fn speak(&self) -> String {
        self.greet()
    }
}

fn run() {
    let g = Greeter { name: String::new() };
    let _m: HashMap<String, String> = HashMap::new();
    g.greet();
}
`,
  ],
  ruby: [
    new RubyAdapter(),
    'src/a.rb',
    `require 'json'
require_relative 'util'

class Base
end

class Greeter < Base
  def initialize(name)
    @name = name
  end

  def greet
    helper(@name)
  end
end

def run
  g = Greeter.new('x')
  g.greet
end
`,
  ],
  php: [
    new PhpAdapter(),
    'src/a.php',
    `<?php
namespace App;

use App\Util\Helper;
use Vendor\Lib\Thing;

require_once 'util.php';

interface Speaker {
    public function speak();
}

class Base {}

class Greeter extends Base implements Speaker {
    public function speak() {
        return $this->greet();
    }

    public function greet() {
        return Helper::help('x');
    }
}

function run() {
    $g = new Greeter();
    $g->greet();
}
`,
  ],
  c: [
    new CAdapter('c'),
    'src/a.c',
    `#include <stdio.h>
#include "util.h"

struct Greeter {
    int id;
};

int greet(struct Greeter *g) {
    return helper(g->id);
}

int run(void) {
    struct Greeter g = { 1 };
    printf("%d", greet(&g));
    return 0;
}
`,
  ],
  cpp: [
    new CAdapter('cpp'),
    'src/a.cpp',
    `#include <vector>
#include "util.hpp"

class Base {};

class Greeter : public Base {
public:
    int greet() {
        return helper(1);
    }
    int twice() {
        return greet() * 2;
    }
};

int run() {
    Greeter g;
    return g.twice();
}
`,
  ],
  kotlin: [
    new KotlinAdapter(),
    'src/a.kt',
    `package app

import kotlin.collections.List
import app.util.helper

interface Speaker {
    fun speak(): String
}

open class Base

class Greeter(val name: String) : Base(), Speaker {
    override fun speak(): String = greet()

    fun greet(): String {
        return helper(name)
    }
}

fun run() {
    val g = Greeter("x")
    g.greet()
}
`,
  ],
  csharp: [
    new CSharpAdapter(),
    'src/A.cs',
    `using System;
using App.Util;

namespace App
{
    public interface ISpeaker
    {
        string Speak();
    }

    public class Base { }

    public class Greeter : Base, ISpeaker
    {
        public string Speak()
        {
            return Greet();
        }

        public string Greet()
        {
            return Helper.Help("x");
        }
    }

    public class Runner
    {
        public void Run()
        {
            var g = new Greeter();
            g.Greet();
        }
    }
}
`,
  ],
};

async function view(lang: string): Promise<ParsedView> {
  const [adapter, relPath, source] = SNIPPETS[lang];
  return parseSnippet(adapter, relPath, source);
}

const ALL_LANGS = ['python', 'go', 'java', 'rust', 'ruby', 'php', 'c', 'cpp', 'kotlin', 'csharp'];

describe('python adapter', () => {
  it('extracts classes, inheritance and external imports', async () => {
    const v = await view('python');
    expect(v.node('file', 'a.py')).toBeDefined();
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('class', 'Base')).toBeDefined();
    expect(v.edgesOf('inherits')).toContainEqual({
      from: v.node('class', 'Greeter')!.id,
      to: v.node('class', 'Base')!.id,
    });
    expect(v.node('external_dep', 'os')?.isExternal).toBe(true);
    expect(v.edgesOf('imports').some((e) => e.to === 'external_dep:os')).toBe(true);
  });
  it('extracts free functions (methods are currently also emitted as functions)', async () => {
    const v = await view('python');
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('function', 'greet')).toBeDefined();
    expect(v.kinds.method ?? 0).toBe(0);
  });
  it('currently emits no calls or contains edges', async () => {
    const v = await view('python');
    expect(v.edgesOf('calls')).toEqual([]);
    expect(v.edgesOf('contains')).toEqual([]);
  });
  it.todo(
    'python: methods should be kind "method" scoped to their class and linked by contains edges',
  );
  it.todo('python: calls edges (run -> Greeter.greet, greet -> helper) are not extracted');
  it('does not create external_dep nodes for relative imports', async () => {
    const v = await view('python');
    expect(v.kinds.external_dep).toBe(1); // only `os`
    expect(v.node('external_dep', 'util')).toBeUndefined();
    expect(v.node('external_dep', '.')).toBeUndefined();
  });
  describe('relative imports', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgb-py-'));
      fs.mkdirSync(path.join(dir, 'pkg', 'sub'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'pkg', 'other'), { recursive: true });
      for (const f of [
        'pkg/__init__.py',
        'pkg/util.py',
        'pkg/sibling.py',
        'pkg/sub/__init__.py',
        'pkg/sub/main.py',
        'pkg/other/__init__.py',
        'pkg/other/mod.py',
      ]) {
        fs.writeFileSync(path.join(dir, f), '');
      }
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    async function importsOf(
      file: string,
      source: string,
    ): Promise<{ to: string[]; externals: number }> {
      const parsed = await new PythonAdapter().parse(path.join(dir, file), source);
      return {
        to: parsed.edges.filter((e) => e.kind === 'imports').map((e) => e.toId),
        externals: parsed.nodes.filter((n) => n.kind === 'external_dep').length,
      };
    }
    const fileId = (rel: string): string => 'file:' + path.join(dir, rel);

    it('resolves "from .b import x" to <pkg>/b.py', async () => {
      const { to } = await importsOf('pkg/a.py', 'from .util import helper\n');
      expect(to).toEqual([fileId('pkg/util.py')]);
    });
    it('resolves "from . import x" to submodule files', async () => {
      const { to } = await importsOf('pkg/a.py', 'from . import sibling, util as u\n');
      expect(to).toEqual([fileId('pkg/sibling.py'), fileId('pkg/util.py')]);
    });
    it('falls back to the package __init__.py for "from . import name"', async () => {
      const { to } = await importsOf('pkg/a.py', 'from . import something\n');
      expect(to).toEqual([fileId('pkg/__init__.py')]);
    });
    it('resolves "from ..other.mod import z" up one package level', async () => {
      const { to } = await importsOf('pkg/sub/main.py', 'from ..other.mod import z\n');
      expect(to).toEqual([fileId('pkg/other/mod.py')]);
    });
    it('resolves a package directory via __init__.py', async () => {
      const { to } = await importsOf('pkg/a.py', 'from .sub import x\n');
      expect(to).toEqual([fileId('pkg/sub/__init__.py')]);
    });
    it('emits no edge and no external node for an unresolvable relative import', async () => {
      const { to, externals } = await importsOf(
        'pkg/a.py',
        'from .missing import x\nfrom ...far import y\n',
      );
      expect(to).toEqual([]);
      expect(externals).toBe(0);
    });
  });
});

describe('go adapter', () => {
  it('extracts struct, interface, function, methods and imports', async () => {
    const v = await view('go');
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('interface', 'Speaker')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('method', 'Greet')).toBeDefined();
    expect(v.node('method', 'Speak')).toBeDefined();
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:fmt', 'external_dep:example.com/proj/internal/util']),
    );
  });
  it.todo('go: calls edges (run -> Greet, Speak -> Greet) are not extracted');
  it.todo(
    'go: methods are not scoped to their receiver type (id is #Greet) and have no contains edge',
  );
  it.todo('go: module-local imports (example.com/proj/...) are all treated as external');
  it.todo(
    'go: implicit interface satisfaction (Greeter implements Speaker) yields no implements edge',
  );
});

describe('java adapter', () => {
  it('extracts classes, interface, methods, inheritance and implements', async () => {
    const v = await view('java');
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('class', 'Base')).toBeDefined();
    expect(v.node('interface', 'Speaker')).toBeDefined();
    expect(v.node('method', 'greet')).toBeDefined();
    expect(v.edgesOf('inherits')).toContainEqual({
      from: v.node('class', 'Greeter')!.id,
      to: v.node('class', 'Base')!.id,
    });
    expect(v.edgesOf('implements')).toContainEqual({
      from: v.node('class', 'Greeter')!.id,
      to: v.node('interface', 'Speaker')!.id,
    });
  });
  it('emits import edges to external deps', async () => {
    const v = await view('java');
    expect(v.edgesOf('imports').length).toBeGreaterThan(0);
    expect(v.kinds.external_dep).toBeGreaterThan(0);
  });
  it.todo('java: calls edges (speak -> greet, run -> greet) are not extracted');
  it.todo(
    'java: imports collapse to the first package segment (java.util.List -> "java", app.util.Helper -> "app"); no local resolution',
  );
  it.todo('java: methods are not scoped to their class (id is #greet) and have no contains edge');
});

describe('rust adapter', () => {
  it('extracts struct, trait, function, methods and imports', async () => {
    const v = await view('rust');
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('interface', 'Speaker')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('method', 'greet')).toBeDefined();
    expect(v.node('method', 'speak')).toBeDefined();
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:std', 'external_dep:crate']),
    );
  });
  it.todo('rust: calls edges (run -> greet, speak -> greet) are not extracted');
  it.todo('rust: impl Speaker for Greeter yields no implements edge');
  it.todo(
    'rust: use crate::... is treated as an external dep named "crate" instead of a local import',
  );
  it.todo(
    'rust: methods are not scoped to their impl type (id is #greet) and have no contains edge',
  );
});

describe('ruby adapter', () => {
  it('currently cannot parse: the ruby WASM grammar crashes web-tree-sitter 0.20.8', async () => {
    await expect(view('ruby')).rejects.toThrow(/apply/);
  });
  it.todo(
    'ruby: parser throws "Cannot read properties of undefined (reading apply)" for ANY input (grammar/runtime mismatch); no nodes or edges at all',
  );
  it.todo(
    'ruby: once parsing works, verify require/require_relative imports, class < Base inheritance, def methods and calls',
  );
});

describe('php adapter', () => {
  it('extracts classes, interface, function and methods', async () => {
    const v = await view('php');
    expect(v.node('file', 'a.php')).toBeDefined();
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('class', 'Base')).toBeDefined();
    expect(v.node('interface', 'Speaker')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('method', 'greet')).toBeDefined();
    expect(v.node('method', 'speak')).toBeDefined();
  });
  it('currently emits only exports edges', async () => {
    const v = await view('php');
    expect(v.edges.every((e) => e.kind === 'exports')).toBe(true);
  });
  it.todo('php: use / require_once imports produce no imports edges or external_dep nodes');
  it.todo('php: extends / implements produce no inherits / implements edges');
  it.todo('php: calls edges are not extracted');
  it.todo('php: no contains edges; methods are not scoped to their class');
});

describe('c adapter', () => {
  it('extracts struct, functions and #include imports', async () => {
    const v = await view('c');
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:stdio.h', 'external_dep:util.h']),
    );
  });
  it('emits the struct once and finds greet (no bogus "g" function)', async () => {
    const v = await view('c');
    expect(v.nodes.filter((n) => n.kind === 'class' && n.name === 'Greeter')).toHaveLength(1);
    expect(v.node('function', 'greet')).toBeDefined();
    expect(v.node('function', 'g')).toBeUndefined();
  });
  it.todo(
    'c: quoted local includes ("util.h") are treated as external deps instead of local imports',
  );
  it.todo('c: calls edges (run -> greet) are not extracted');
});

describe('cpp adapter', () => {
  it('extracts classes, free function, methods and #include imports', async () => {
    const v = await view('cpp');
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('class', 'Base')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('method', 'greet')).toBeDefined();
    expect(v.node('method', 'twice')).toBeDefined();
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:vector', 'external_dep:util.hpp']),
    );
  });
  it.todo('cpp: class Greeter : public Base yields no inherits edge');
  it.todo('cpp: calls edges (twice -> greet, run -> twice) are not extracted');
  it.todo('cpp: quoted local includes ("util.hpp") are treated as external deps');
  it.todo('cpp: methods are not scoped to their class and have no contains edge');
});

describe('kotlin adapter', () => {
  it('extracts classes, interface, functions and import edges', async () => {
    const v = await view('kotlin');
    expect(v.node('file', 'a.kt')).toBeDefined();
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('class', 'Base')).toBeDefined();
    expect(v.node('interface', 'Speaker')).toBeDefined();
    expect(v.node('function', 'run')).toBeDefined();
    expect(v.node('method', 'greet')).toBeDefined();
    expect(v.node('method', 'speak')).toBeDefined();
    expect(v.node('class', 'name')).toBeUndefined();
    expect(v.node('class', 'speak')).toBeUndefined();
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:kotlin', 'external_dep:app']),
    );
  });
  it.todo('kotlin: ": Base(), Speaker" yields no inherits / implements edges');
  it.todo('kotlin: calls edges are not extracted');
  it.todo('kotlin: imports collapse to the first package segment ("kotlin", "app")');
});

describe('csharp adapter', () => {
  it('extracts namespace, classes, interface, scoped methods and contains edges', async () => {
    const v = await view('csharp');
    expect(v.node('module', 'App')).toBeDefined();
    expect(v.node('class', 'Greeter')).toBeDefined();
    expect(v.node('interface', 'ISpeaker')).toBeDefined();
    expect(v.nodes.some((n) => n.kind === 'method' && n.id.endsWith('#Greeter.Greet'))).toBe(true);
    expect(v.edgesOf('contains')).toContainEqual({
      from: v.node('class', 'Greeter')!.id,
      to: expect.stringMatching(/#Greeter\.Greet$/),
    });
  });
  it('extracts inheritance and same-class calls', async () => {
    const v = await view('csharp');
    expect(v.edgesOf('inherits')).toContainEqual({
      from: v.node('class', 'Greeter')!.id,
      to: v.node('class', 'Base')!.id,
    });
    expect(v.edgesOf('calls')).toContainEqual({
      from: expect.stringMatching(/#Greeter\.Speak$/),
      to: expect.stringMatching(/#Greeter\.Greet$/),
    });
  });
  it('emits using-directive imports as external deps', async () => {
    const v = await view('csharp');
    expect(v.edgesOf('imports').map((e) => e.to)).toEqual(
      expect.arrayContaining(['external_dep:System', 'external_dep:App']),
    );
  });
  it.todo(
    'csharp: interface implementation is emitted as inherits (Greeter -> ISpeaker), not implements',
  );
  it.todo('csharp: calls through a variable receiver (g.Greet() in Runner.Run) are not extracted');
  it.todo(
    'csharp: "using App.Util;" collapses to the first namespace segment ("App"); no local resolution',
  );
});

// [kind, symbol, needle (first source line that starts the declaration), signature must contain]
const META_CASES: Record<string, Array<[string, string, string, string]>> = {
  python: [
    ['class', 'Greeter', 'class Greeter(Base):', 'class Greeter(Base)'],
    ['function', 'run', 'def run():', 'def run()'],
  ],
  go: [
    ['class', 'Greeter', 'type Greeter struct', 'Greeter struct'],
    ['method', 'Greet', 'func (g *Greeter) Greet()', 'func (g *Greeter) Greet() string'],
  ],
  java: [
    ['class', 'Greeter', 'public class Greeter', 'class Greeter extends Base implements Speaker'],
    ['method', 'greet', 'public String greet()', 'public String greet()'],
  ],
  rust: [
    ['class', 'Greeter', 'struct Greeter', 'struct Greeter'],
    ['function', 'run', 'fn run()', 'fn run()'],
  ],
  php: [
    ['class', 'Greeter', 'class Greeter', 'class Greeter extends Base implements Speaker'],
    ['function', 'run', 'function run()', 'function run()'],
  ],
  c: [
    ['function', 'greet', 'int greet(', 'int greet(struct Greeter *g)'],
    ['class', 'Greeter', 'struct Greeter {', 'struct Greeter'],
  ],
  cpp: [
    ['class', 'Greeter', 'class Greeter', 'class Greeter : public Base'],
    ['function', 'run', 'int run()', 'int run()'],
  ],
  kotlin: [
    ['class', 'Greeter', 'class Greeter(', 'class Greeter(val name: String)'],
    ['function', 'run', 'fun run()', 'fun run()'],
  ],
  csharp: [
    ['class', 'Greeter', 'public class Greeter', 'public class Greeter'],
    ['method', 'Greet', 'public string Greet()', 'public string Greet()'],
  ],
};

describe('line ranges and signatures (all non-TS adapters)', () => {
  for (const lang of ALL_LANGS.filter((l) => l !== 'ruby')) {
    it(`${lang}: file node spans the whole file and symbols carry line ranges + signatures`, async () => {
      const v = await view(lang);
      const source = SNIPPETS[lang][2];
      const lines = source.split('\n');
      const file = v.nodes.find((n) => n.kind === 'file')!;
      expect(file.startLine).toBe(1);
      expect(file.endLine).toBe(source.replace(/\n$/, '').split('\n').length);

      for (const [kind, symbol, needle, sigPart] of META_CASES[lang]) {
        const n = v.node(kind, symbol);
        expect(n).toBeDefined();
        const expectedStart = lines.findIndex((l) => l.includes(needle)) + 1;
        expect(n!.startLine).toBe(expectedStart);
        expect(n!.endLine).toBeGreaterThanOrEqual(n!.startLine!);
        expect(n!.signature).toContain(sigPart);
        expect(n!.signature).not.toMatch(/[{]$/);
        expect(n!.signature!.length).toBeLessThanOrEqual(200);
      }
      // every non-file, non-external node has a valid range
      for (const n of v.nodes.filter((x) => x.kind !== 'file' && !x.isExternal)) {
        expect(n.startLine).toBeGreaterThanOrEqual(1);
        expect(n.endLine).toBeGreaterThanOrEqual(n.startLine!);
        expect(n.endLine).toBeLessThanOrEqual(lines.length);
        expect(n.signature).toBeTruthy();
      }
    });
  }
  it('multi-line declarations span their full body', async () => {
    const v = await view('java');
    const g = v.node('class', 'Greeter')!;
    expect(g.endLine! - g.startLine!).toBe(10);
  });
  it.todo('ruby: no line ranges (adapter cannot parse, see ruby todo above)');
});

describe('exported flag and doc comments', () => {
  it('go: capitalised names are exported', async () => {
    const v = await view('go');
    expect(v.node('method', 'Greet')!.exported).toBe(true);
    expect(v.node('function', 'run')!.exported).toBe(false);
  });
  it('python: leading underscore is not exported; docstrings become doc', async () => {
    const v = await parseSnippet(
      new PythonAdapter(),
      'src/m.py',
      'def pub():\n    """Public one.\n\n    More."""\n    pass\n\ndef _priv():\n    pass\n',
    );
    expect(v.node('function', 'pub')).toMatchObject({ exported: true, doc: 'Public one.' });
    expect(v.node('function', '_priv')!.exported).toBe(false);
    expect(v.node('function', '_priv')!.doc).toBeUndefined();
  });
  it('java / csharp / kotlin: public (or default-public) modifier drives exported', async () => {
    const java = await view('java');
    expect(java.node('class', 'Greeter')!.exported).toBe(true);
    expect(java.node('class', 'Base')!.exported).toBe(false);
    const cs = await view('csharp');
    expect(cs.node('class', 'Greeter')!.exported).toBe(true);
    const kt = await view('kotlin');
    expect(kt.node('function', 'run')!.exported).toBe(true);
  });
  it('rust: pub drives exported; /// docs become doc', async () => {
    const v = await parseSnippet(
      new RustAdapter(),
      'src/l.rs',
      '/// Does the thing.\n/// Really.\npub fn a() {}\n\nfn b() {}\n',
    );
    expect(v.node('function', 'a')).toMatchObject({
      exported: true,
      doc: 'Does the thing. Really.',
    });
    expect(v.node('function', 'b')).toMatchObject({ exported: false });
  });
  it('go / csharp / php: leading comments become doc', async () => {
    const go = await parseSnippet(
      new GoAdapter(),
      'src/d.go',
      'package p\n\n// Hello says hi.\nfunc Hello() {}\n',
    );
    expect(go.node('function', 'Hello')!.doc).toBe('Hello says hi.');
    const cs = await parseSnippet(
      new CSharpAdapter(),
      'src/D.cs',
      'public class D\n{\n    /// <summary>Runs it.</summary>\n    public void Run() { }\n}\n',
    );
    expect(cs.node('method', 'Run')!.doc).toBe('Runs it.');
    const php = await parseSnippet(
      new PhpAdapter(),
      'src/d.php',
      '<?php\n/** Does x. */\nfunction x() {}\n',
    );
    expect(php.node('function', 'x')!.doc).toBe('Does x.');
  });
});
