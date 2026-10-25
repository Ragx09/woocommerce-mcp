// BON-10: the small pure helpers of the "Add by image" form.
import { describe, expect, it } from 'vitest';
import { parseEnv, slugFrom } from '../src/pages/Hosted.js';

describe('parseEnv', () => {
  it('NAME=value per line; blanks ignored; the value may contain = and spaces', () => {
    expect(parseEnv('A=1\n\n B = x\nURL=http://h/?a=b c\n').env).toEqual({ A: '1', B: ' x', URL: 'http://h/?a=b c' });
  });
  it('a line without NAME= is an error that names the line', () => {
    expect(parseEnv('A=1\nnonsense').error).toBe('line 2: write NAME=value');
    expect(parseEnv('=x').error).toMatch(/line 1/);
  });
});
describe('slugFrom', () => {
  it('lower-case ASCII with single hyphens, at most 16 characters', () => {
    expect(slugFrom('Everything MCP (demo)')).toBe('everything-mcp-d');
    expect(slugFrom('Ünï Çode')).toBe('uni-code');
    expect(slugFrom('A very long server name indeed')).toBe('a-very-long-serv');
  });
});
