import { describe, it, expect, afterEach } from 'vitest';
import { requiredEnv } from './env.utils';

describe('requiredEnv', () => {
  afterEach(() => {
    delete process.env.SOME_TEST_VAR;
  });

  it('returns the trimmed value when the variable is set', () => {
    process.env.SOME_TEST_VAR = '  hello  ';
    expect(requiredEnv('SOME_TEST_VAR')).toBe('hello');
  });

  it('throws when the variable is not set', () => {
    delete process.env.SOME_TEST_VAR;
    expect(() => requiredEnv('SOME_TEST_VAR')).toThrow(
      'Missing required environment variable: SOME_TEST_VAR'
    );
  });

  it('throws when the variable is set to an empty/whitespace string', () => {
    process.env.SOME_TEST_VAR = '   ';
    expect(() => requiredEnv('SOME_TEST_VAR')).toThrow(
      'Missing required environment variable: SOME_TEST_VAR'
    );
  });
});
