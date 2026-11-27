// How the bot shows its feelings at the table: a line of Hinglish chat, an emoji reaction, or
// something thrown, the way a friend at a home game would. Light banter only, never abuse.
// Each event has a few ways to react, each with a chance; bots.js keeps it from getting spammy.

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const fill = (s, ev) => s.replace(/\{name\}/g, ev.name || 'bhai');

const LINES = {
  bigWin: ['aaj toh apna din hai 😎', 'shukriya shukriya 🙏', 'ye pot toh mera hi tha bhai', 'chips aao papa ke paas 💰', 'itna bada pot! party kab hai? 🍻', 'maza aa gaya 🔥', 'sorry bhai, cards hi aise aaye 😅', 'aur bhejo aur bhejo 😁'],
  win: ['chalo kuch toh aaya 😌', 'ek aur 🤑', 'theek hai theek hai', '😏', 'dheere dheere 😎'],
  bigLoss: ['yaar ye kya ho gaya 😤', 'aaj kismat hi kharab hai', 'koi baat nahi, wapas aayenge 💪', 'ek pot se kya hota hai', 'uff 😩', 'dil toot gaya 💔', 'chalo, agla haath 😤'],
  badBeat: ['{name} bhai river pe? seriously? 😤', '{name} kya luck hai yaar 🙄', 'river ne maar diya 😭', '{name} aaj tumhe bhagwan bacha raha hai', 'kya chal raha hai ye 😑', '{name} ye call kaise kiya yaar 😳'],
  crushed: ['{name} sorry bhai 😅', '{name} achha try tha 👏', 'next time {name} 😉', '{name} dil pe mat lena 😁'],
  theyBluffedMe: ['{name} bluff?! 😳 yaad rakhunga', '{name} bade dil wale ho 😂', '{name} ab har baar call karunga dekhna 😤', 'arre {name}! 🙈'],
  theyBluffed: ['{name} kya bluff tha 😂', '{name} hero banne ka shauk hai 😆', 'waah {name} waah 👏'],
  caughtBluffing: ['haan haan bluff tha, toh? 😜', 'pakda gaya 🙈', 'kabhi kabhi chalta hai 😅', 'try toh karna padta hai 😁'],
  cardDead: ['aaj cards hi nahi aa rahe 😴', 'kab aayenge achhe cards yaar', 'fold fold fold... 🥱', '72 offsuit ka din hai aaj 😩'],
  hello: ['hi bhai 👋', 'aur kya haal hai?', 'chalo shuru karte hain 🔥', 'aa gaye sab? 😎'],
  gg: ['gg 🤝', 'gg bhai', 'wp 👍', 'gg, kal phir 😁'],
  nh: ['ty 😁', 'shukriya 🙏', 'thanks bhai', '😎🙏'],
  thrown: ['😂 ruk ja', 'abe! 😤', 'ye kya tha 😆', 'badla lunga 😏'],
};

const REACT = {
  bigWin: ['money', 'fire', 'clap'],
  win: ['money', 'fire'],
  bigLoss: ['cry', 'dead', 'scream'],
  badBeat: ['scream', 'cry', 'dead'],
  crushed: ['laugh', 'clap'],
  theyBluffedMe: ['wow', 'scream'],
  theyBluffed: ['laugh', 'wow'],
  caughtBluffing: ['laugh'],
};

const THROW = {
  bigWin: ['money', 'kiss', 'cake', 'beer'], // at the player who lost the most
  badBeat: ['slipper', 'slap', 'tomato', 'egg'], // at whoever cracked it
  crushed: ['rose', 'cake', 'beer'],
  theyBluffedMe: ['egg', 'tomato', 'slipper'],
  thrown: ['tomato', 'egg', 'slipper', 'punch', 'fish'],
};

// Chances, for "normal" talkativeness: [chat, react, throw].
const CHANCE = {
  bigWin: [0.35, 0.5, 0.2],
  win: [0.08, 0.15, 0],
  bigLoss: [0.4, 0.5, 0],
  badBeat: [0.45, 0.3, 0.35],
  crushed: [0.25, 0.2, 0.12],
  theyBluffedMe: [0.45, 0.35, 0.3],
  theyBluffed: [0.25, 0.3, 0],
  caughtBluffing: [0.5, 0.2, 0],
  cardDead: [0.25, 0, 0],
  thrown: [0.3, 0, 0.55],
  hello: [0.6, 0, 0],
  gg: [0.6, 0, 0],
  nh: [0.6, 0, 0],
};

export const TALK_LEVELS = { off: 0, low: 0.5, normal: 1, high: 1.7 };

// What to do about one event: a list of { type: 'chat' | 'react' | 'throw', ... }, possibly empty.
export function reactTo(ev, level = 'normal') {
  const mult = TALK_LEVELS[level] ?? 1;
  if (!mult) return [];
  const kind = ev.kind === 'theyBluffed' && ev.againstMe ? 'theyBluffedMe' : ev.kind;
  const [c, r, t] = CHANCE[kind] || [0, 0, 0];
  const out = [];
  if (LINES[kind] && Math.random() < c * mult) out.push({ type: 'chat', text: fill(pick(LINES[kind]), ev) });
  if (REACT[kind] && Math.random() < r * mult) out.push({ type: 'react', emote: pick(REACT[kind]) });
  if (THROW[kind] && ev.seat != null && Math.random() < t * mult) out.push({ type: 'throw', to: ev.seat, item: ev.item && Math.random() < 0.5 ? ev.item : pick(THROW[kind]) });
  return out;
}

// Something someone said at the table that the bot might answer.
export function chatEvent(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(gg|good game|ggwp)\b/.test(t)) return 'gg';
  if (/\b(nh|nice hand|nice one|wp|well played)\b/.test(t)) return 'nh';
  if (/\b(hi|hello|hey|namaste|hlo|helo)\b/.test(t)) return 'hello';
  return null;
}
