import { describe, expect, it } from 'vitest';
import { resolveConfig, validateConfig, withDefaults } from '../../src/core/config';
import { openUrlBlock } from '../../src/core/blocks/openUrl';
import { timerBlock } from '../../src/core/blocks/timer';
import { watchElementBlock } from '../../src/core/blocks/watchElement';

describe('withDefaults', () => {
  it('fills in missing settings', () => {
    expect(withDefaults(timerBlock, {})).toEqual({ seconds: 60, repeat: true });
  });

  it('keeps user settings and coerces numeric strings', () => {
    expect(withDefaults(timerBlock, { seconds: '15', repeat: false })).toEqual({
      seconds: 15,
      repeat: false,
    });
  });
});

describe('resolveConfig', () => {
  it('renders templated fields from the input payload', () => {
    const { config, errors } = resolveConfig(openUrlBlock, { url: '{{url}}' }, { url: 'https://a.com' });
    expect(errors).toEqual([]);
    expect(config).toEqual({ ...openUrlBlock.defaultConfig, url: 'https://a.com' });
  });

  it('does not render fields that are not templated', () => {
    const { config } = resolveConfig(watchElementBlock, { selector: '{{x}}', url: 'a.com' }, { x: 'y' });
    expect((config as { selector: string }).selector).toBe('{{x}}');
  });

  it('reports a missing required value after rendering', () => {
    const { errors } = resolveConfig(openUrlBlock, { url: '{{url}}' }, {});
    expect(errors).toEqual(['URL is required']);
  });

  it('reports an invalid URL', () => {
    const { errors } = resolveConfig(openUrlBlock, { url: 'javascript:alert(1)' }, {});
    expect(errors).toEqual(['URL must be a valid http(s) URL']);
  });
});

describe('validateConfig', () => {
  it('checks number ranges', () => {
    expect(validateConfig(timerBlock, { seconds: 0, repeat: true })).toEqual(['Seconds must be at least 1']);
    expect(validateConfig(timerBlock, { seconds: 'abc', repeat: true })).toEqual(['Seconds must be a number']);
    expect(validateConfig(timerBlock, { seconds: 5, repeat: true })).toEqual([]);
  });

  it('accepts templated URLs while designing but not when running', () => {
    const config = withDefaults(openUrlBlock, { url: 'https://x.com/{{id}}' });
    expect(validateConfig(openUrlBlock, config, 'design')).toEqual([]);
    expect(validateConfig(openUrlBlock, { ...config, url: '{{ id }}' }, 'design')).toEqual([]);
  });

  it('requires the watch selector', () => {
    const errors = validateConfig(watchElementBlock, withDefaults(watchElementBlock, { url: 'a.com' }));
    expect(errors).toEqual(['Element is required']);
  });
});
