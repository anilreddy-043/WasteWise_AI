import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProductSymbol from "./ProductSymbol";
import { CAULIFLOWER_SYMBOL, PAPAYA_SYMBOL } from "../services/productSymbols";

describe("ProductSymbol", () => {
  it("renders the locally bundled papaya illustration instead of a melon emoji", () => {
    render(<ProductSymbol symbol={PAPAYA_SYMBOL} />);

    const image = document.querySelector(".product-symbol-image");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", "/product-symbols/papaya.png");
    expect(image).toHaveAttribute("alt", "");
  });

  it("keeps Unicode product symbols unchanged", () => {
    const { container } = render(<ProductSymbol symbol="🥭" />);

    expect(container).toHaveTextContent("🥭");
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("uses a separate locally bundled illustration for cauliflower", () => {
    const { container } = render(<ProductSymbol symbol={CAULIFLOWER_SYMBOL} />);

    expect(container.querySelector("img")).toHaveAttribute("src", "/product-symbols/cauliflower.png");
  });

  it("recognizes a cauliflower product key embedded in stored display text", () => {
    const { container } = render(<ProductSymbol symbol={`${CAULIFLOWER_SYMBOL} Cauliflower Vegetables`} />);

    expect(container.querySelector("img")).toHaveAttribute("src", "/product-symbols/cauliflower.png");
    expect(container).not.toHaveTextContent("cauliflower:commons-cc0");
  });
});
