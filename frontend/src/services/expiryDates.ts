const SHELF_LIFE_DAYS: Record<string, number> = {
  Seafood: 2,
  "Meat & Poultry": 3,
  "Dairy Products": 9,
  "Bakery Products": 5,
  Vegetables: 9,
  Fruits: 9,
  "Ready-to-Eat Foods": 4,
  "Fresh Juices": 3,
  "Frozen Foods": 228,
  Beverages: 105,
};

const CATEGORY_ALIASES: Record<string, string> = {
  dairy: "Dairy Products",
  bakery: "Bakery Products",
  beverage: "Beverages",
};

export function configureShelfLifeDays(settings: Array<{ category: string; days: number }>): void {
  for (const setting of settings) {
    SHELF_LIFE_DAYS[setting.category] = setting.days;
  }
}

export function getShelfLifeDays(category: string): number | undefined {
  const normalizedCategory = category.trim().toLowerCase();
  const canonicalCategory = CATEGORY_ALIASES[normalizedCategory]
    ?? Object.keys(SHELF_LIFE_DAYS).find((name) => name.toLowerCase() === normalizedCategory);
  return canonicalCategory ? SHELF_LIFE_DAYS[canonicalCategory] : undefined;
}

export function calculateSuggestedExpiryDate(
  category: string,
  receivedDate: string,
): string | undefined {
  const shelfLifeDays = getShelfLifeDays(category);
  if (!shelfLifeDays || !/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) return undefined;

  const [year, month, day] = receivedDate.split("-").map(Number);
  const receivedTimestamp = Date.UTC(year, month - 1, day);
  const received = new Date(receivedTimestamp);
  if (
    received.getUTCFullYear() !== year
    || received.getUTCMonth() !== month - 1
    || received.getUTCDate() !== day
  ) return undefined;

  return new Date(receivedTimestamp + shelfLifeDays * 86400000).toISOString().slice(0, 10);
}

export function localDateIso(value = new Date()): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}
