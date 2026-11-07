import { useState } from "react";
import { productImage, uploadedProductImage } from "../services/productImages";

type ProductImageProps = {
  productId?: number;
  productName: string;
  imageUrl?: string | null;
  className?: string;
};

export default function ProductImage({ productId, productName, imageUrl, className = "" }: ProductImageProps) {
  const fallbackSrc = "/images/products/image-unavailable.svg";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSources = [
    uploadedProductImage(imageUrl),
    productImage(productId, productName),
  ].filter((source): source is string => source !== null);
  const src = imageSources.find((source) => source !== failedSrc);
  const hasPhoto = Boolean(src);

  return (
    <span
      className={`product-image ${className}`.trim()}
      role="img"
      aria-label={hasPhoto ? `${productName} product photo` : `Product photo unavailable for ${productName}`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <img src={fallbackSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" />
      )}
    </span>
  );
}
