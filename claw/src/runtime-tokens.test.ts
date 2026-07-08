import { describe, expect, it } from 'vitest';
import { resolveClawTokens } from './runtime-tokens.js';

describe('resolveClawTokens', () => {
  it('accepts a Discord-only deployment', () => {
    expect(resolveClawTokens({ DISCORD_TOKEN: 'd' })).toEqual({
      discordToken: 'd',
      telegramToken: undefined,
    });
  });

  it('accepts a Telegram-only deployment', () => {
    expect(resolveClawTokens({ TELEGRAM_TOKEN: 't' })).toEqual({
      discordToken: undefined,
      telegramToken: 't',
    });
  });

  it('accepts both tokens', () => {
    expect(
      resolveClawTokens({ DISCORD_TOKEN: 'd', TELEGRAM_TOKEN: 't' }),
    ).toEqual({ discordToken: 'd', telegramToken: 't' });
  });

  it('trims whitespace and treats blank tokens as absent', () => {
    expect(() =>
      resolveClawTokens({ DISCORD_TOKEN: '   ', TELEGRAM_TOKEN: '' }),
    ).toThrow(/At least one of DISCORD_TOKEN or TELEGRAM_TOKEN/);
  });

  it('fails fast when neither token is present', () => {
    expect(() => resolveClawTokens({})).toThrow(
      /At least one of DISCORD_TOKEN or TELEGRAM_TOKEN/,
    );
  });
});
