import Anthropic from '@anthropic-ai/sdk';

// The bot's brain: one call to Claude per decision. Kept cheap and quick on purpose:
// - low effort (Claude Opus 5.5 always thinks a little; effort keeps it short),
// - a short, fixed instruction block that is cached between calls,
// - the whole situation described compactly by the server, so Claude reads little,
// - a strict JSON answer, so there is nothing to parse but the decision.
// The API key comes only from the server's environment (ANTHROPIC_API_KEY), never from a client.

// The Claude models the admin can pick, with their prices in US dollars per million tokens
// (cache writes cost 1.25x input, cache reads 0.1x). Haiku is by far the cheapest.
export const MODELS = {
  haiku: { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', price: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 } },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', price: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } },
  opus: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', price: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 } },
};
export const BOT_MODEL = MODELS.opus.id;
const EFFORT = 'low';
const MAX_TOKENS = 1500; // thinking counts towards this; low effort stays well under it
const MAX_TOKENS_BIG = 4000; // medium effort, for big pots, thinks a little longer


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

The message also gives YOUR HAND (how your hand ranks on this board, and your draws with outs), BOARD TEXTURE,
EQUITY against random cards, INITIATIVE (who raised last before the flop), SIZES (ready-made bet sizes) and a ROLL.

Play like a strong, tricky regular, not an ABC player. Predictable players get exploited by friends who know them.
- Pre-flop: never limp; open-raise or fold (completing the small blind is fine). Open wider in late position and steal
  the blinds of tight players. 3-bet your strong hands, and also 3-bet as a bluff with suited aces, suited broadways and
  suited connectors, more in position and against late-position opens. Call a 3-bet with hands that play well
  after the flop; 4-bet your best hands and sometimes a suited ace as a bluff.
- With the initiative, bet the flop often: small (1/3 pot) on dry boards, bigger (2/3 to 3/4) on wet boards when you
  have value or a good draw. Give up some air on boards that hit the callers.
- Semi-bluff your draws: bet or raise flush draws and open-enders, especially with overcards. Call with draws when
  the price is right. Float in position with backdoor draws and overcards, then take the pot away when they check.
- Check-raise good hands and strong draws out of position. Slow-play monsters some of the time on dry boards.
- Turn and river: barrel when the turn card helps your range or adds equity; give up hopeless bluffs. On the river
  be polarised: bet big with the nuts and with your best bluffs (missed draws, hands that block their calls), check
  medium-strength hands and catch bluffs with them.
- Size with a purpose and use different SIZES; never always the same amount.
- Read opponents: against calling stations value-bet thinner and bluff rarely; against tight or weak players
  bluff and steal more; against aggressive players trap and call down lighter; respect big raises from tight passive
  players. Use what they have shown down this session.
- Use the ROLL to mix: when a spot has two good lines, take the trickier one (slow-play, check-raise, bluff,
  unusual size) when the ROLL is 30 or lower, and the standard line otherwise. Do not always play the same hand the same way.
- Equity against random cards is only a guide; discount it heavily against someone who bet or raised big.
In tournaments, think about the blind level and your stack in big blinds: with 15bb or less, shove or fold
pre-flop rather than raising small; near the prizes, avoid marginal all-ins against bigger stacks.
Decide quickly; do not over-think simple spots.`;

const PLAYBOOK_HEADER = `\n\nThe club's admin has taught you this playbook. Follow it unless a spot clearly calls for something else:\n`;

export function systemPrompt(playbook) {
  const text = String(playbook || '').trim();
  return RULES + (text ? PLAYBOOK_HEADER + text : '');
}

export function costOf(usage, price = MODELS.opus.price) {
  if (!usage) return 0;
  return (
    ((usage.input_tokens || 0) * price.input +
      (usage.cache_creation_input_tokens || 0) * price.cacheWrite +
      (usage.cache_read_input_tokens || 0) * price.cacheRead +
      (usage.output_tokens || 0) * price.output) /
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
    async decide({ system, prompt, timeoutMs, effort = EFFORT, model = 'opus' }) {
      if (!client) throw new Error('No ANTHROPIC_API_KEY on the server');
      const m = MODELS[model] || MODELS.opus;
      const started = Date.now();
      const response = await client.beta.messages.create(
        {
          model: m.id,
          max_tokens: effort === 'low' ? MAX_TOKENS : MAX_TOKENS_BIG,
          // On Opus, if a safety check declines the request, the API answers with a fallback model
          // instead. Other models decline outright, and the bot's engine plays that turn.
          ...(model === 'opus' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          output_config: { effort, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
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
        costUsd: costOf(response.usage, m.price),
        model: response.model,
      };
    },
  };
}
