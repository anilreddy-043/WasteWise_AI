import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProductImage from "./ProductImage";
import { productImage } from "../services/productImages";

describe("product image mapping", () => {
  it("uses product identity before the product name", () => {
    expect(productImage(3, "Unrelated Name")).toBe("/images/products/3-mangoes.jpg");
  });

  it("prefers an uploaded image over the catalog photo", () => {
    render(<ProductImage productId={3} productName="Mangoes" imageUrl="/api/v1/products/3/image?v=123" />);
    expect(screen.getByRole("img", { name: "Mangoes product photo" }).querySelector("img"))
      .toHaveAttribute("src", "/api/v1/products/3/image?v=123");
  });

  it("matches names case-insensitively when an ID has no photo", () => {
    expect(productImage(999, "FRESH MANGOES")).toBe("/images/products/3-mangoes.jpg");
    expect(productImage(undefined, "  toor-dal ")).toBe("/images/products/34-toor-dal.jpg");
  });

  it("returns no photo for unverified products instead of assigning an unrelated one", () => {
    expect(productImage(undefined, "Unknown Product")).toBeNull();
  });

  it("uses an explicit fallback for products without a verified photo", () => {
    render(<ProductImage productId={999} productName="Unknown Product" />);
    expect(screen.getByRole("img", { name: "Product photo unavailable for Unknown Product" }).querySelector("img"))
      .toHaveAttribute("src", "/images/products/image-unavailable.svg");
  });

  it("replaces a failed product photo with the fallback asset", () => {
    render(<ProductImage productId={3} productName="Mangoes" />);
    const image = screen.getByRole("img", { name: "Mangoes product photo" }).querySelector("img");
    expect(image).toHaveAttribute("src", "/images/products/3-mangoes.jpg");
    fireEvent.error(image!);
    const fallback = screen.getByRole("img", { name: "Product photo unavailable for Mangoes" });
    expect(fallback.querySelector("img")).toHaveAttribute("src", "/images/products/image-unavailable.svg");
  });

  it("uses lazy loading and a stable square asset", () => {
    render(<ProductImage productId={3} productName="Mangoes" />);
    expect(screen.getByRole("img", { name: "Mangoes product photo" }).querySelector("img"))
      .toHaveAttribute("loading", "lazy");
    expect(document.querySelector(".product-image")).toHaveClass("product-image");
  });
});
