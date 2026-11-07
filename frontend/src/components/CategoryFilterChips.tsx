type CategoryFilterChipsProps = {
  categories: string[];
  value: string;
  onChange: (category: string) => void;
  ariaLabel: string;
  allLabel?: string;
  disabled?: boolean;
};

function shortCategoryLabel(category: string): string {
  const shortLabels: Record<string, string> = {
    "Bakery Products": "Bakery",
    "Dairy Products": "Dairy",
    "Ready-to-Eat Foods": "Ready-to-Eat",
    "Cooking Essentials": "Cooking",
  };
  return shortLabels[category] ?? category;
}

export default function CategoryFilterChips({
  categories,
  value,
  onChange,
  ariaLabel,
  allLabel = "All",
  disabled = false,
}: CategoryFilterChipsProps) {
  const options = [{ label: allLabel, value: "All Categories" }, ...categories.map((category) => ({
    label: shortCategoryLabel(category),
    value: category,
  }))];

  return (
    <div className="category-filter-chips" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="category-filter-chip"
          aria-label={option.value === "All Categories" ? allLabel : option.value}
          aria-pressed={value === option.value}
          title={option.value === "All Categories" ? allLabel : option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
