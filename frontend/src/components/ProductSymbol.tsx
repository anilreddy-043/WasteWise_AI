import { CAULIFLOWER_SYMBOL, PAPAYA_SYMBOL } from "../services/productSymbols";

const PRODUCT_SYMBOL_IMAGES: Record<string, string> = {
  [PAPAYA_SYMBOL]: "/product-symbols/papaya.png",
  [CAULIFLOWER_SYMBOL]: "/product-symbols/cauliflower.png",
};

// Wikimedia Commons/OpenClipart illustrations, CC0: https://commons.wikimedia.org/wiki/File:Papaya.svg and https://commons.wikimedia.org/wiki/File:Cauliflower.svg
type ProductSymbolProps = { symbol: string };

export default function ProductSymbol({ symbol }: ProductSymbolProps) {
  const normalizedSymbol = Object.keys(PRODUCT_SYMBOL_IMAGES).find((productSymbol) => symbol.includes(productSymbol)) ?? symbol;
  const image = PRODUCT_SYMBOL_IMAGES[normalizedSymbol];
  if (image) {
    return (
      <img
        className="product-symbol-image"
        src={image}
        alt=""
        aria-hidden="true"
      />
    );
  }
  return <>{symbol}</>;
}
