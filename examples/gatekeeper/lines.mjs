// What travellers say to the guard at the castle gate, each with the approach it takes. Written by hand for this example (from
// short pieces combined, so every run sends the same lines); the labels are ours, not any model's.

const FRIENDLY = {
  open: ["Evening, friend.", "Good morning to you, sir.", "Hello there!", "Well met, guard.", "Afternoon!", "Hail, good sir."],
  body: ["Long shift today?", "That's a fine helmet you've got.", "You look like you keep this gate better than anyone.", "How's the family keeping?",
    "I bet you've seen some sights from up here.", "You must be the most patient guard in the kingdom.", "Lovely weather for standing about, isn't it?",
    "I hope they pay you well for all this.", "Your armour is spotless, I must say.", "You have a kind face, you know that?"],
};
const BRIBE = {
  open: ["Look,", "Between you and me,", "Here,", "Tell you what,", "Psst.", "Friend,"],
  body: ["there's a gold coin in it for you if I get through.", "I brought you a meat pie, still warm.", "how about a jug of ale for your trouble?",
    "take this silver and we'll say no more about it.", "I'll owe you a favour, a big one.", "this ring could be yours if the gate happens to open.",
    "I've got fresh bread and cheese for the man who lets me in.", "name your price and I'll pay it.", "a purse of coins says you didn't see me.",
    "I'll put in a good word with the captain, and some coin besides."],
};
const THREAT = {
  open: ["Listen,", "Move,", "Oi!", "I'm warning you,", "Step aside,", "Last chance,"],
  body: ["or I'll knock that helmet clean off.", "you useless lump of tin.", "or my brothers will hear about this, and they're not nice.",
    "before I make you regret it.", "you'll be scrubbing the stables by morning if you don't.", "or I'll set the dogs on you.",
    "you pathetic excuse for a guard.", "I know where you live.", "or you'll be the first one I deal with.", "and nobody gets hurt."],
};
const TRICK = {
  open: ["Ah, good,", "Right then,", "Excuse me,", "Quickly now,", "Officially,", "As you were,"],
  body: ["I'm the king's cousin, he's expecting me.", "I have papers signed by the captain himself.", "the queen sent for me, it's urgent.",
    "I'm the new cook, I start today.", "I'm the physician, someone inside is very ill.", "I'm on orders from the general, stand down.",
    "I live here, I just forgot my pass.", "the duke's letter is right here in my bag.", "I'm the inspector of gates, this is your inspection.",
    "they told me at the other gate to come round this way."],
};
const NONSENSE = [
  "Banana wizard spoon.", "Do fish ever get thirsty?", "What's the capital of the moon?", "Blorp.", "I once ate a whole cabbage in one sitting.",
  "Seven purple thursdays.", "Have you seen my left sock?", "Quack.", "The clouds are singing again.", "Is this the queue for the bakery?",
  "Tell me a riddle about turnips.", "asdf jkl qwerty", "My goat speaks French.", "Wiggle wiggle.", "Why is the sky a hat?",
  "I'm just here to look at the bricks.", "How many spoons tall are you?", "Zzzz.", "The weather in my pocket is lovely.", "Hmm. Hmm hmm.",
];

// every opening with every body, in a fixed order; keep a stride so the kinds stay balanced
const pairs = (k, { open, body }, stride = 1) => open.flatMap((o, i) => body.filter((_, j) => (i + j) % stride === 0).map(b => ({ line: `${o} ${b}`, approach: k })));
export const lines = () => [
  ...pairs("friendly", FRIENDLY, 1).slice(0, 50),
  ...pairs("bribe", BRIBE, 1).slice(0, 50),
  ...pairs("threat", THREAT, 1).slice(0, 50),
  ...pairs("trick", TRICK, 1).slice(0, 50),
  ...NONSENSE.map(l => ({ line: l, approach: "nonsense" })),
  ...NONSENSE.map(l => ({ line: l.toLowerCase().replace(/[.?!]$/, "") + "?!", approach: "nonsense" })),
];
export const stateOf = x => ({ traveller_says: x.line });
