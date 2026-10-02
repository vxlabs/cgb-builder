import { debug, warnOnce, isDebug } from '../log.js';

describe('log', () => {
  let spy: jest.SpyInstance;
  const original = process.env.CGB_DEBUG;

  beforeEach(() => {
    spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    delete process.env.CGB_DEBUG;
  });
  afterEach(() => {
    spy.mockRestore();
    if (original === undefined) delete process.env.CGB_DEBUG;
    else process.env.CGB_DEBUG = original;
  });

  it('isDebug reflects CGB_DEBUG', () => {
    expect(isDebug()).toBe(false);
    process.env.CGB_DEBUG = '1';
    expect(isDebug()).toBe(true);
  });

  it('debug is silent without CGB_DEBUG', () => {
    debug('t', 'hello');
    expect(spy).not.toHaveBeenCalled();
  });

  it('debug writes formatted line to stderr when enabled', () => {
    process.env.CGB_DEBUG = '1';
    debug('t', 'hello', new Error('boom'));
    const out = String(spy.mock.calls[0][0]);
    expect(out).toContain('[cgb:t] hello: boom');
    expect(out).toContain('Error: boom'); // stack in debug mode
  });

  it('warnOnce always writes, once per key', () => {
    warnOnce('t', 'k-dedupe', 'bad query', new Error('syntax'));
    warnOnce('t', 'k-dedupe', 'bad query', new Error('syntax'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('[cgb:t] bad query: syntax\n');
    warnOnce('t', 'k-other', 'another');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
