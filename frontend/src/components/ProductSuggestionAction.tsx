import { useEffect, useRef, useState } from "react";
import { getProductSuggestion, type ProductSuggestion } from "../services/productSuggestions";
import { suggestProductSku, type ProductSkuSuggestionRecord } from "../services/business";

type ProductSuggestionActionProps = {
  productName: string;
  selectedCategory: string;
  savedSku?: string;
  refreshToken?: number;
  onApply: (suggestion: ProductSuggestion, sku?: string) => void;
  onApplySku: (sku: string) => void;
};

export default function ProductSuggestionAction({
  productName,
  selectedCategory,
  savedSku,
  refreshToken = 0,
  onApply,
  onApplySku,
}: ProductSuggestionActionProps) {
  const suggestion = getProductSuggestion(productName);
  const [skuSuggestion, setSkuSuggestion] = useState<ProductSkuSuggestionRecord | null>(null);
  const [skuError, setSkuError] = useState("");
  const [skuLoading, setSkuLoading] = useState(false);
  const selectedCategoryRef = useRef(selectedCategory);

  useEffect(() => {
    selectedCategoryRef.current = selectedCategory;
  }, [selectedCategory]);

  useEffect(() => {
    if (!suggestion || savedSku) {
      setSkuSuggestion(null);
      setSkuError("");
      setSkuLoading(false);
      return;
    }

    let active = true;
    setSkuSuggestion(null);
    setSkuError("");
    setSkuLoading(true);
    const timer = window.setTimeout(() => {
      suggestProductSku(suggestion.category)
        .then((result) => {
          if (active) setSkuSuggestion(result);
        })
        .catch((error: unknown) => {
          if (active) {
            setSkuError(error instanceof Error ? error.message : "Could not check the next available SKU.");
          }
        })
        .finally(() => {
          if (active) setSkuLoading(false);
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [productName, refreshToken, savedSku, suggestion?.category]);

  async function generateSkuForSelectedCategory() {
    const requestedCategory = selectedCategory;
    setSkuLoading(true);
    setSkuError("");
    try {
      const result = await suggestProductSku(requestedCategory);
      if (selectedCategoryRef.current === requestedCategory) {
        setSkuSuggestion(result);
        onApplySku(result.sku);
      }
    } catch (error) {
      setSkuError(error instanceof Error ? error.message : "Could not check the next available SKU.");
    } finally {
      setSkuLoading(false);
    }
  }

  if (!productName.trim()) return null;

  return (
    <section className="product-suggestion-panel" aria-label="Product suggestions">
      {suggestion ? (
        <>
          <div className="product-suggestion-values">
            <p><span>Suggested Category</span><strong>{suggestion.category}</strong></p>
            <p><span>Suggested Unit</span><strong>{suggestion.unit}</strong></p>
            <p>
              <span>{savedSku && !skuSuggestion ? "Saved SKU" : "Suggested SKU"}</span>
              <strong>{savedSku && !skuSuggestion ? savedSku : skuLoading ? "Checking availability…" : skuSuggestion?.sku ?? "Not available"}</strong>
            </p>
          </div>
          <button
            className="product-suggestion-apply"
            type="button"
            onClick={() => onApply(suggestion, savedSku ? undefined : skuSuggestion?.sku)}
            disabled={skuLoading}
          >
            <span>Suggested</span>
            <b>Apply Suggestions</b>
          </button>
          {savedSku && skuSuggestion && (
            <button
              className="product-suggestion-generate"
              type="button"
              onClick={() => onApplySku(skuSuggestion.sku)}
            >
              Use suggested SKU
            </button>
          )}
        </>
      ) : (
        <p className="product-suggestion-empty" role="status">
          No category or unit suggestion available. Choose these manually.
        </p>
      )}
      <button
        className="product-suggestion-generate"
        type="button"
        onClick={() => void generateSkuForSelectedCategory()}
        disabled={skuLoading || !selectedCategory}
      >
        {skuLoading ? "Checking SKU…" : savedSku ? "Generate a different SKU" : "Generate SKU from selected category"}
      </button>
      {skuError && <p className="product-suggestion-error" role="alert">{skuError}</p>}
      {!suggestion && !skuError && !skuLoading && skuSuggestion && (
        <p className="product-suggestion-current" role="status">Next available: {skuSuggestion.sku}</p>
      )}
    </section>
  );
}
