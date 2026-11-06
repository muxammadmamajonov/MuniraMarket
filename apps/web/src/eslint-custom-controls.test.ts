// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Proves the "no browser-default controls" lint rules in `eslint.config.mjs` really fire, so a
 * native select, dialog, picker input or alert cannot slip into the storefront unnoticed.
 */

const eslint = new ESLint({ cwd: path.resolve(__dirname, '..') });
const FILE = path.resolve(__dirname, 'components/__lint-fixture__.tsx');

async function violations(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: FILE });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-syntax')
    .map((message) => message.message);
}

describe('custom-control lint protections', () => {
  it.each([
    ['<select />', /Native <select>/],
    ['<option />', /Native <option>/],
    ['<datalist />', /Native <datalist>/],
    ['<dialog open />', /Native <dialog>/],
    ['<input type="date" />', /browser-default control/],
    ['<input type="time" />', /browser-default control/],
    ['<input type="datetime-local" />', /browser-default control/],
    ['<input type="month" />', /browser-default control/],
    ['<input type="week" />', /browser-default control/],
    ['<input type="color" />', /browser-default control/],
    ['<input type="range" />', /browser-default control/],
    ['<input type="file" />', /browser-default control/],
    ['<input type="search" />', /browser-default control/],
    ["<input type={'search'} />", /browser-default control/],
  ])('rejects %s', async (jsx, message) => {
    const found = await violations(`export const X = () => ${jsx};\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(message);
  });

  it.each([
    'alert("x")',
    'confirm("x")',
    'prompt("x")',
    'window.alert("x")',
    'globalThis.confirm("x")',
  ])('rejects %s', async (call) => {
    const found = await violations(`export function f() {\n  ${call};\n}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/browser dialog/);
  });

  it('allows the semantic, visually hidden controls the custom components are built on', async () => {
    const code = [
      'export const X = () => (',
      '  <>',
      '    <input type="radio" className="sr-only" />',
      '    <input type="checkbox" role="switch" className="sr-only" />',
      '    <input type="text" role="searchbox" />',
      '    <input type="tel" />',
      '  </>',
      ');',
      '',
    ].join('\n');
    expect(await violations(code)).toEqual([]);
  });
});
