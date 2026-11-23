import Anthropic from '@anthropic-ai/sdk';

// The bot's brain: one call to Claude per decision. Kept cheap and quick on purpose:
// - low effort (Claude Opus 5.5 always thinks a little; effort keeps it short),
// - a short, fixed instruction block that is cached between calls,
// - the whole situation described compactly by the server, so Claude reads little,
// - a strict JSON answer, so there is nothing to parse but the decision.
// The API key comes only from the server's environment (ANTHROPIC_API_KEY), never from a client.

export const BOT_MODEL = 'claude-opus-5-5';
const EFFORT = 'low';
const MAX_TOKENS = 1500; // thinking counts towards this; low effort stays well under it

// Claude Opus 5.5 prices in US dollars per million tokens (cache writes cost 1.25x input).
const PRICE = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['fold', 'check', 'call', 'raise'] },
    amount: { type: 'integer', description: 'For raise: the total amount to raise to. Otherwise 0.' },
    reason: { type: 'string', description: 'A few words, for the log.' },
  },
  required: ['action', 'amount', 'reason'],
  additionalProperties: false,
};

const RULES = `You are an AI poker player at a friendly No-Limit Texas Hold'em club (play money).
Each message describes the table at the moment it is your turn: the game, your cards, the board, the pot,
every player with their stack and their tendencies this session, everything that has happened in this hand,
and exactly which moves you may make. Decide your move.

How to answer:
- action is one of the moves listed as available. "raise" also means bet when nobody has bet yet.
- For raise, amount is the total you raise to (not the extra), within the range given. All-in = the maximum.
- Otherwise amount is 0.
- reason is at most 12 words, for the admin's log.

Play well and like a thoughtful human: think about position, stack sizes in big blinds, pot odds, ranges,
board texture, and what each opponent has shown this session. Mix up your play so you are hard to read.
In tournaments, think about survival and the blind level. Decide quickly; do not over-think simple spots.`;

const PLAYBOOK_HEADER = `\n\nThe club's admin has taught you this playbook. Follow it unless a spot clearly calls for something else:\n`;

export function systemPrompt(playbook) {
  const text = String(playbook || '').trim();
  return RULES + (text ? PLAYBOOK_HEADER + text : '');
}

export function costOf(usage) {
  if (!usage) return 0;
  return (
    ((usage.input_tokens || 0) * PRICE.input +
      (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
      (usage.cache_read_input_tokens || 0) * PRICE.cacheRead +
      (usage.output_tokens || 0) * PRICE.output) /
    1e6
  );
}

export function createBrain(apiKey = process.env.ANTHROPIC_API_KEY) {
  // No retries: a decision has to land within the player's turn, and the bot plays a safe move instead.
  const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null;

  return {
    ready: () => !!client,
    model: BOT_MODEL,

    // Returns { action, amount, reason, ms, usage, costUsd, model } or throws.
    async decide({ system, prompt, timeoutMs }) {
      if (!client) throw new Error('No ANTHROPIC_API_KEY on the server');
      const started = Date.now();
      const response = await client.beta.messages.create(
        {
          model: BOT_MODEL,
          max_tokens: MAX_TOKENS,
          // If a safety check declines the request, the API answers with a fallback model instead.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          output_config: { effort: EFFORT, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
          messages: [{ role: 'user', content: prompt }],
        },
        { timeout: timeoutMs },
      );
      const ms = Date.now() - started;
      if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer');
      if (response.stop_reason === 'max_tokens') throw new Error('Answer was cut off');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const out = JSON.parse(text);
      return {
        action: out.action,
        amount: Number.isFinite(out.amount) ? Math.floor(out.amount) : 0,
        reason: String(out.reason || '').slice(0, 160),
        ms,
        usage: response.usage,
        costUsd: costOf(response.usage),
        model: response.model,
      };
    },
  };
}
