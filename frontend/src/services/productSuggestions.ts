export const PRODUCT_CATEGORIES = [
  "Fruits",
  "Vegetables",
  "Dairy Products",
  "Bakery Products",
  "Meat & Poultry",
  "Seafood",
  "Beverages",
  "Snacks",
  "Grains & Cereals",
  "Pulses & Lentils",
  "Spices & Masalas",
  "Cooking Essentials",
  "Frozen Foods",
  "Ready-to-Eat Foods",
  "Fresh Juices",
  "Condiments & Sauces",
  "Personal Care",
  "Household Essentials",
  "Other",
] as const;

export const PRODUCT_UNITS = [
  "Kilogram (kg)",
  "Gram (g)",
  "Milligram (mg)",
  "Litre (L)",
  "Millilitre (ml)",
  "Piece (pcs)",
  "Unit",
  "Packet (pkt)",
  "Pack",
  "Box",
  "Carton (ctn)",
  "Bottle (btl)",
  "Can",
  "Dozen (doz)",
  "Bundle (bdl)",
  "Bag",
  "Tray",
  "Jar",
  "Roll",
  "Tub",
] as const;

export type ProductSuggestion = {
  category: (typeof PRODUCT_CATEGORIES)[number];
  unit: (typeof PRODUCT_UNITS)[number];
};

type SuggestionRule = ProductSuggestion & { aliases: string[] };

const suggestionRules: SuggestionRule[] = [
  { aliases: ["banana", "bananas", "bannana", "bannanas", "bananna", "plantain", "plantains"], category: "Fruits", unit: "Piece (pcs)" },
  { aliases: ["apple", "apples", "aple"], category: "Fruits", unit: "Kilogram (kg)" },
  { aliases: ["fresh milk", "milk", "whole milk", "cow milk", "dairy milk"], category: "Dairy Products", unit: "Litre (L)" },
  { aliases: ["butter", "salted butter", "unsalted butter"], category: "Dairy Products", unit: "Pack" },
  { aliases: ["basmati rice", "rice", "brown rice", "white rice", "jasmine rice"], category: "Grains & Cereals", unit: "Kilogram (kg)" },
  { aliases: ["wheat flour", "flour", "atta", "whole wheat flour"], category: "Grains & Cereals", unit: "Kilogram (kg)" },
  { aliases: ["tomato", "tomatoes", "tomatos", "tomatoe"], category: "Vegetables", unit: "Kilogram (kg)" },
  { aliases: ["potato", "potatoes", "potatos", "potatoe"], category: "Vegetables", unit: "Kilogram (kg)" },
  { aliases: ["brown bread", "bread", "whole wheat bread", "white bread"], category: "Bakery Products", unit: "Pack" },
  { aliases: ["chicken", "chiken", "chicken breast", "chicken meat"], category: "Meat & Poultry", unit: "Kilogram (kg)" },
  { aliases: ["fresh fish", "fish", "salmon", "tuna", "prawn", "prawns", "shrimp", "seafood"], category: "Seafood", unit: "Kilogram (kg)" },
  { aliases: ["fresh juice", "fresh juices", "freshly squeezed juice", "cold-pressed juice"], category: "Fresh Juices", unit: "Litre (L)" },
  { aliases: ["orange juice", "juice", "fruit juice", "beverage"], category: "Beverages", unit: "Litre (L)" },
  { aliases: ["potato chips", "chips", "crisps", "snack packet"], category: "Snacks", unit: "Packet (pkt)" },
  { aliases: ["turmeric powder", "turmeric", "haldi powder", "spice powder"], category: "Spices & Masalas", unit: "Packet (pkt)" },
  { aliases: ["sunflower oil", "cooking oil", "vegetable oil", "oil"], category: "Cooking Essentials", unit: "Litre (L)" },
  { aliases: ["frozen peas", "frozen pea", "frozen vegetables", "frozen food"], category: "Frozen Foods", unit: "Packet (pkt)" },
  { aliases: ["tomato ketchup", "ketchup", "tomato sauce"], category: "Condiments & Sauces", unit: "Bottle (btl)" },
  { aliases: ["shampoo", "shampu", "hair shampoo"], category: "Personal Care", unit: "Bottle (btl)" },
  { aliases: ["detergent", "detergant", "washing powder", "laundry detergent"], category: "Household Essentials", unit: "Packet (pkt)" },
  { aliases: ["chocolate", "chocolates", "chocolate bar"], category: "Snacks", unit: "Piece (pcs)" },
  { aliases: ["yogurt", "yoghurt", "curd"], category: "Dairy Products", unit: "Pack" },
  { aliases: ["cheese"], category: "Dairy Products", unit: "Pack" },
  { aliases: ["egg", "eggs"], category: "Dairy Products", unit: "Dozen (doz)" },
  { aliases: ["orange", "oranges"], category: "Fruits", unit: "Kilogram (kg)" },
  { aliases: ["tomato ketchup bottle"], category: "Condiments & Sauces", unit: "Bottle (btl)" },
];

function normalizeProductName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const normalizedRules = suggestionRules.map((rule) => ({
  ...rule,
  normalizedAliases: rule.aliases.map(normalizeProductName),
}));

export function getProductSuggestion(
  productName: string,
  categories: readonly string[] = PRODUCT_CATEGORIES,
  units: readonly string[] = PRODUCT_UNITS,
): ProductSuggestion | null {
  const query = normalizeProductName(productName);
  if (query.length < 3) return null;

  const matches = normalizedRules.flatMap((rule) => rule.normalizedAliases.flatMap((alias) => {
    if (query === alias) return [{ rule, alias, priority: 0 }];
    if (query.length >= 4 && alias.startsWith(query)) return [{ rule, alias, priority: 1 }];
    if (alias.length >= 5 && query.startsWith(`${alias} `)) return [{ rule, alias, priority: 2 }];
    return [];
  })).sort((a, b) => a.priority - b.priority || b.alias.length - a.alias.length);
  const rule = matches[0]?.rule;
  if (!rule || !categories.includes(rule.category) || !units.includes(rule.unit)) return null;

  return { category: rule.category, unit: rule.unit };
}

export function findExistingProduct<T extends { name: string }>(
  products: readonly T[],
  productName: string,
): T | undefined {
  const query = normalizeProductName(productName);
  if (!query) return undefined;
  return products.find((product) => normalizeProductName(product.name) === query);
}
