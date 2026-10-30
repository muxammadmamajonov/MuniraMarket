import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tgcloud');
const ALLOWED_BARE = new Set(['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch']);
const FORBIDDEN_GLOBALS = new Set([
  'Buffer',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'atob',
  'btoa',
  'structuredClone',
  'queueMicrotask',
]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT);

function parse(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
}

/** Collects every module specifier (static and dynamic) plus forbidden global references. */
function inspect(file) {
  const specifiers = [];
  const dynamic = [];
  const globalsUsed = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      dynamic.push(node.getText());
    }
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isPropertyKey =
        (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      const isDeclaration =
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isBindingElement(parent);
      if (!isMemberName && !isPropertyKey && !isDeclaration) globalsUsed.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return { specifiers, dynamic, globalsUsed };
}

describe('tgcloud/ runtime constraints', () => {
  it('contains only .js modules in the documented layout', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep);
      expect(file.endsWith('.js'), `${rel.join('/')} must be .js`).toBe(true);
      const top = rel[0];
      if (rel.length === 1) expect(rel[0]).toBe('schema.js');
      else expect(['lib', 'handlers', 'endpoints']).toContain(top);
      if (top === 'handlers' || top === 'endpoints') {
        expect(rel.length, `${rel.join('/')} must be flat`).toBe(2);
      }
    }
  });

  it('imports only sdk modules or relative .js files that exist inside tgcloud/', () => {
    for (const file of files) {
      const { specifiers, dynamic } = inspect(file);
      expect(dynamic, `${file}: dynamic import`).toEqual([]);
      for (const spec of specifiers) {
        if (spec.startsWith('.')) {
          expect(spec.endsWith('.js'), `${file}: "${spec}" needs the .js extension`).toBe(true);
          const target = resolve(dirname(file), spec);
          expect(target.startsWith(ROOT + sep), `${file}: "${spec}" leaves tgcloud/`).toBe(true);
          expect(existsSync(target), `${file}: "${spec}" does not exist`).toBe(true);
        } else {
          expect(ALLOWED_BARE.has(spec), `${file}: "${spec}" is not an allowed import`).toBe(true);
        }
      }
    }
  });

  it('uses no globals that the Serverless runtime does not document', () => {
    for (const file of files) {
      expect(inspect(file).globalsUsed, relative(ROOT, file)).toEqual([]);
    }
  });

  it('only entry points and the notification/profile logic import from sdk', () => {
    const importers = files
      .filter((file) => inspect(file).specifiers.some((s) => s === 'sdk' || s.startsWith('sdk/')))
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .sort();
    expect(importers).toEqual([
      'endpoints/getProfile.js',
      'handlers/message.js',
      'lib/miniapp/profile.js',
      'lib/notifications/orderStatus.js',
      'schema.js',
    ]);
  });

  it('handlers and endpoints have a default export', () => {
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep);
      if (rel[0] !== 'handlers' && rel[0] !== 'endpoints') continue;
      const hasDefault = parse(file).statements.some(
        (s) =>
          ts.isExportAssignment(s) ||
          (ts.isFunctionDeclaration(s) &&
            s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)),
      );
      expect(hasDefault, `${rel.join('/')} needs export default`).toBe(true);
      if (rel[0] === 'endpoints')
        expect(rel[1].replace(/\.js$/, '')).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('schema.js declares no foreign keys (the DSL throws on them)', () => {
    const source = readFileSync(join(ROOT, 'schema.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/\.references\(|foreignKey\(/);
  });

  it('ships no secrets: nothing in tgcloud/ looks like a token or a literal secret', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/); // bot token shape
      expect(source, file).not.toMatch(/app\d+:[A-Za-z0-9_-]{20,}/); // tgcloud token shape
      expect(source, file).not.toMatch(/test-only-secret/);
    }
  });
});
