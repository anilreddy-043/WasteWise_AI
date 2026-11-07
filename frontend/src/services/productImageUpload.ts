const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The selected image could not be optimized."));
      }
    }, "image/webp", quality);
  });
}

export async function prepareProductImage(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `This image format could not be opened: ${error.message}`
        : "This image format could not be opened.",
    );
  }

  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The selected image could not be optimized in this browser.");
    }

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let optimized: Blob | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      optimized = await canvasBlob(canvas, Math.max(0.5, 0.88 - attempt * 0.07));
      if (optimized.size <= MAX_UPLOAD_BYTES && optimized.type === "image/webp") break;

      canvas.width = Math.max(1, Math.floor(canvas.width * 0.8));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.8));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }

    if (!optimized || optimized.size > MAX_UPLOAD_BYTES || optimized.type !== "image/webp") {
      throw new Error("This image could not be optimized to a supported size. Try a smaller image.");
    }

    const name = file.name.replace(/\.[^.]+$/, "") || "product-image";
    return new File([optimized], `${name}.webp`, {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}
