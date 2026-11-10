import { describe, expect, it } from 'vitest';
import { DEFAULT_OUT_DIR, DEFAULT_TIMEOUT_SECONDS, UsageError, parseCliArgs } from '../../packages/cli/index.mjs';

describe('parseCliArgs', () => {
  it('parses run with every flag', () => {
    const options = parseCliArgs([
      'run', 'a.script.json', 'flows/', '--report', 'junit,html', '--report', 'json', '--report', 'junit', '--out', 'out',
      '--headed', '--browser', '/bin/chromium', '--extension', 'ext', '--timeout', '90', '--secret', 'token=a=b', '--secret', 'pw=x',
    ]);
    expect(options).toEqual({
      command: 'run',
      inputs: ['a.script.json', 'flows/'],
      suite: undefined,
      reports: ['junit', 'html', 'json'],
      out: 'out',
      headed: true,
      browser: '/bin/chromium',
      extension: 'ext',
      timeoutSeconds: 90,
      secrets: { token: 'a=b', pw: 'x' },
    });
  });

  it('has defaults', () => {
    const options = parseCliArgs(['run', 'x.json']);
    expect(options).toMatchObject({ reports: [], out: DEFAULT_OUT_DIR, headed: false, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, secrets: {} });
  });

  it('allows run with only --suite', () => {
    expect(parseCliArgs(['run', '--suite', 'smoke.json'])).toMatchObject({ command: 'run', inputs: [], suite: 'smoke.json' });
  });

  it('returns help and version', () => {
    expect(parseCliArgs([]).command).toBe('help');
    expect(parseCliArgs(['--help']).command).toBe('help');
    expect(parseCliArgs(['run', '-h']).command).toBe('help');
    expect(parseCliArgs(['-v']).command).toBe('version');
  });

  it.each([
    [['frobnicate']],
    [['run']],
    [['validate']],
    [['run', 'a.json', '--report', 'pdf']],
    [['run', 'a.json', '--timeout', 'soon']],
    [['run', 'a.json', '--timeout', '0']],
    [['run', 'a.json', '--secret', 'novalue']],
    [['run', 'a.json', '--secret', '=x']],
    [['run', 'a.json', '--bogus']],
    [['run', 'a.json', '--out']],
    [['validate', 'a.json', '--report', 'junit']],
    [['validate', 'a.json', '--secret', 'a=b']],
  ])('rejects %j', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
