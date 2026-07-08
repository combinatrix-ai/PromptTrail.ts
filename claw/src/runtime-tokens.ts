/**
 * Channel-token resolution for claw. Claw now boots with a Discord gateway, a
 * Telegram gateway, or both. Fail-fast only when NEITHER token is present — a
 * single configured channel is a valid deployment.
 */
export interface ClawTokens {
  discordToken?: string;
  telegramToken?: string;
}

export function resolveClawTokens(
  env: Record<string, string | undefined>,
): ClawTokens {
  const discordToken = optional(env.DISCORD_TOKEN);
  const telegramToken = optional(env.TELEGRAM_TOKEN);
  if (!discordToken && !telegramToken) {
    throw new Error(
      'At least one of DISCORD_TOKEN or TELEGRAM_TOKEN is required.',
    );
  }
  return { discordToken, telegramToken };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
