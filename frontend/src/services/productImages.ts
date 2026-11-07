const imageFor = (file: string): string => `/images/products/catalog/${file}.jpg`;
const legacyImageFor = (productId: number, file: string): string => `/images/products/${productId}-${file}.jpg`;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

const productImagesById: Record<number, string> = {
  3: legacyImageFor(3, "mangoes"),
  4: legacyImageFor(4, "tomatoes"),
  5: imageFor("potatoes"),
  6: imageFor("onions"),
  7: legacyImageFor(7, "carrots"),
  8: imageFor("fresh-milk"),
  9: imageFor("butter"),
  10: imageFor("basmati-rice"),
  12: imageFor("green-grapes"),
  13: legacyImageFor(13, "watermelon"),
  14: legacyImageFor(14, "papaya"),
  20: imageFor("pineapple"),
  21: imageFor("cucumber"),
  22: imageFor("cauliflower"),
  23: legacyImageFor(23, "green-capsicum"),
  24: imageFor("broccoli"),
  25: legacyImageFor(25, "green-peas"),
  26: imageFor("sweet-corn"),
  27: imageFor("cheese"),
  28: imageFor("paneer"),
  30: imageFor("fresh-cream"),
  31: imageFor("buttermilk"),
  32: imageFor("brown-bread"),
  33: imageFor("pav-bread"),
  34: legacyImageFor(34, "toor-dal"),
  35: imageFor("moong-dal"),
  36: legacyImageFor(36, "sunflower-oil"),
  37: imageFor("jaggery"),
  38: imageFor("milk"),
  39: imageFor("fish"),
};

const productImagesByName: Record<string, string> = {
  strawberries: imageFor("strawberries"),
  tomato: imageFor("tomatoes"),
  tomatoes: imageFor("tomatoes"),
  fish: imageFor("fish"),
  fishfillet: imageFor("fish-fillet"),
  kiwi: imageFor("kiwi"),
  pizzabase: imageFor("pizza-base"),
  guava: imageFor("guava"),
  poha: imageFor("poha"),
  freshmilk: imageFor("fresh-milk"),
  milk: imageFor("milk"),
  chickenbreast: imageFor("chicken-breast"),
  sweetcorn: imageFor("sweet-corn"),
  eggstray: imageFor("eggs-tray"),
  cauliflower: imageFor("cauliflower"),
  chanadal: imageFor("chana-dal"),
  prawns: imageFor("prawns"),
  mango: imageFor("mangoes"),
  mangoes: legacyImageFor(3, "mangoes"),
  freshmangoes: legacyImageFor(3, "mangoes"),
  carrots: imageFor("carrots"),
  carrot: imageFor("carrots"),
  cucumber: imageFor("cucumber"),
  rajma: imageFor("rajma"),
  buttermilk: imageFor("buttermilk"),
  flavouredmilk: imageFor("flavoured-milk"),
  coconutwater: imageFor("coconut-water"),
  turmericpowder: imageFor("turmeric-powder"),
  cheeseslices: imageFor("cheese-slices"),
  cheese: imageFor("cheese"),
  potatoes: imageFor("potatoes"),
  greentea: imageFor("green-tea"),
  garammasala: imageFor("garam-masala"),
  croissants: imageFor("croissants"),
  darkchocolate: imageFor("dark-chocolate"),
  oliveoil: imageFor("olive-oil"),
  granolabars: imageFor("granola-bars"),
  frozenparatha: imageFor("frozen-paratha"),
  ragiflour: imageFor("ragi-flour"),
  instantpohacup: imageFor("instant-poha-cup"),
  mayonnaise: imageFor("mayonnaise"),
  handwash: imageFor("hand-wash"),
  onions: imageFor("onions"),
  butter: imageFor("butter"),
  basmatirice: imageFor("basmati-rice"),
  greengrapes: imageFor("green-grapes"),
  watermelon: imageFor("watermelon"),
  papaya: imageFor("papaya"),
  pineapple: imageFor("pineapple"),
  greencapsicum: imageFor("green-capsicum"),
  capsicum: imageFor("green-capsicum"),
  broccoli: imageFor("broccoli"),
  greenpeas: imageFor("green-peas"),
  paneer: imageFor("paneer"),
  freshcream: imageFor("fresh-cream"),
  brownbread: imageFor("brown-bread"),
  pavbread: imageFor("pav-bread"),
  toordal: legacyImageFor(34, "toor-dal"),
  moongdal: imageFor("moong-dal"),
  sunfloweroil: imageFor("sunflower-oil"),
  jaggery: imageFor("jaggery"),
};

function normalizeProductName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function productImage(productId: number | undefined, productName: string): string | null {
  if (productId !== undefined && productImagesById[productId]) {
    return productImagesById[productId];
  }
  return productImagesByName[normalizeProductName(productName)] ?? null;
}

export function uploadedProductImage(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  return API_BASE_URL && imageUrl.startsWith("/") ? `${API_BASE_URL}${imageUrl}` : imageUrl;
}

export const suppliedProductImageCount = 56;
