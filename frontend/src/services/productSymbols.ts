export const PAPAYA_SYMBOL = "papaya:commons-cc0";
export const CAULIFLOWER_SYMBOL = "cauliflower:commons-cc0";

const productSymbols: Record<string, string> = {
  apple: "🍎",
  apples: "🍎",
  banana: "🍌",
  bananas: "🍌",
  orange: "🍊",
  oranges: "🍊",
  mango: "🥭",
  mangoes: "🥭",
  grape: "🍇",
  grapes: "🍇",
  "green grapes": "🍇",
  watermelon: "🍉",
  papaya: PAPAYA_SYMBOL,
  papayas: PAPAYA_SYMBOL,
  pineapple: "🍍",
  pear: "🍐",
  strawberry: "🍓",
  strawberries: "🍓",
  tomato: "🍅",
  tomatoes: "🍅",
  potato: "🥔",
  potatoes: "🥔",
  onion: "🧅",
  onions: "🧅",
  cucumber: "🥒",
  cauliflower: CAULIFLOWER_SYMBOL,
  broccoli: "🥦",
  "green peas": "🫛",
  peas: "🫛",
  spinach: "🥬",
  lettuce: "🥬",
  cabbage: "🥬",
  carrot: "🥕",
  carrots: "🥕",
  "green capsicum": "🫑",
  "bell pepper": "🫑",
  "sweet corn": "🌽",
  corn: "🌽",
  milk: "🥛",
  "fresh milk": "🥛",
  "milk (1l)": "🥛",
  butter: "🧈",
  cheese: "🧀",
  paneer: "🧀",
  yogurt: "🥣",
  "greek yogurt": "🥣",
  curd: "🥣",
  "fresh cream": "🥛",
  "cream (250ml)": "🥛",
  buttermilk: "🥛",
  bread: "🍞",
  "brown bread": "🍞",
  "pav bread": "🥯",
  "wholegrain loaf": "🍞",
  baguette: "🥖",
  bagel: "🥯",
  croissant: "🥐",
  "sponge cake": "🍰",
  cake: "🍰",
  muffin: "🧁",
  rice: "🍚",
  "basmati rice": "🍚",
  "wheat flour": "🌾",
  "toor dal": "🫘",
  "moong dal": "🫘",
  fish: "🐟",
  prawns: "🍤",
  prawn: "🍤",
  shrimp: "🍤",
  chicken: "🍗",
  egg: "🥚",
  eggs: "🥚",
  meat: "🥩",
  "orange juice": "🧃",
  juice: "🧃",
  water: "💧",
  "soft drinks": "🥤",
  "soft drink": "🥤",
  "sunflower oil": "🫙",
  jaggery: "🟫",
  sugar: "🍬",
  salt: "🧂",
  "frozen vegetables": "🥦",
  "frozen snacks": "🧊",
  "prepared meals": "🍱",
  "ready to eat": "🍱",
  sandwich: "🥪",
  biscuits: "🍪",
  avocado: "🥑",
  donut: "🍩",
  lemons: "🍋",
  "cheddar slices": "🧀",
};

const categorySymbols: Array<[RegExp, string]> = [
  [/fruit/, "🍎"],
  [/veget/, "🥬"],
  [/dairy/, "🥛"],
  [/bakery/, "🍞"],
  [/grain|cereal/, "🌾"],
  [/pulse|lentil/, "🫘"],
  [/seafood/, "🐟"],
  [/meat|poultry/, "🍗"],
  [/beverage/, "🥤"],
  [/juice/, "🧃"],
  [/frozen/, "🧊"],
  [/ready.?to.?eat/, "🍱"],
  [/cook|essential/, "🫙"],
  [/snack/, "🍿"],
  [/spice|masala/, "🧂"],
  [/condiment|sauce/, "🫙"],
  [/personal care/, "🧴"],
  [/household/, "🧹"],
];

export function productSymbol(productName: string, category?: string): string {
  const name = productName.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const exactMatch = productSymbols[name];
  if (exactMatch) return exactMatch;

  if (/juice/.test(name)) return "🧃";
  if (/\boranges?\b/.test(name)) return "🍊";
  if (/\bapples?\b/.test(name)) return "🍎";
  if (/bananas?/.test(name)) return "🍌";
  if (/mango/.test(name)) return "🥭";
  if (/grapes?/.test(name)) return "🍇";
  if (/watermelon/.test(name)) return "🍉";
  if (/\bpapayas?\b/.test(name)) return PAPAYA_SYMBOL;
  if (/pineapple/.test(name)) return "🍍";
  if (/tomatoes?/.test(name)) return "🍅";
  if (/potatoes?/.test(name)) return "🥔";
  if (/onions?/.test(name)) return "🧅";
  if (/cucumber/.test(name)) return "🥒";
  if (/\bcauliflower\b/.test(name)) return CAULIFLOWER_SYMBOL;
  if (/\bbroccoli\b/.test(name)) return "🥦";
  if (/peas?/.test(name)) return "🫛";
  if (/spinach|lettuce|cabbage/.test(name)) return "🥬";
  if (/carrots?/.test(name)) return "🥕";
  if (/capsicum|pepper/.test(name)) return "🫑";
  if (/corn|maize/.test(name)) return "🌽";
  if (/butter/.test(name)) return "🧈";
  if (/cheese|paneer/.test(name)) return "🧀";
  if (/yogurt|curd/.test(name)) return "🥣";
  if (/milk|cream|buttermilk/.test(name)) return "🥛";
  if (/eggs?/.test(name)) return "🥚";
  if (/bread|loaf/.test(name)) return "🍞";
  if (/pav|rolls?|bagel|bun/.test(name)) return "🥯";
  if (/cake/.test(name)) return "🍰";
  if (/fish|seafood/.test(name)) return "🐟";
  if (/prawn|shrimp/.test(name)) return "🍤";
  if (/chicken/.test(name)) return "🍗";
  if (/meat/.test(name)) return "🥩";
  if (/rice/.test(name)) return "🍚";
  if (/wheat|flour|grain|oats|barley/.test(name)) return "🌾";
  if (/dal|pulse|lentil|bean|chickpea/.test(name)) return "🫘";
  if (/water/.test(name)) return "💧";
  if (/drink|soda|beverage/.test(name)) return "🥤";
  if (/oil|jaggery/.test(name)) return "🫙";
  if (/sugar/.test(name)) return "🍬";
  if (/salt/.test(name)) return "🧂";
  if (/frozen/.test(name)) return "🧊";
  if (/sandwich/.test(name)) return "🥪";
  if (/meal|prepared food/.test(name)) return "🍱";

  const normalizedCategory = category?.trim().toLowerCase() ?? "";
  return categorySymbols.find(([pattern]) => pattern.test(normalizedCategory))?.[1] ?? "🛍️";
}
