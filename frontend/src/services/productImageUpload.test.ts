import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareProductImage } from "./productImageUpload";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepareProductImage", () => {
  it("resizes large landscape images while preserving their aspect ratio", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 4000,
      height: 1000,
      close: vi.fn(),
    } as unknown as ImageBitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
    ) {
      expect(this.width).toBe(1600);
      expect(this.height).toBe(400);
      callback(new Blob(["optimized"], { type: "image/webp" }));
    });

    const output = await prepareProductImage(new File(["original"], "wide.png", { type: "image/png" }));

    expect(output.name).toBe("wide.webp");
    expect(output.type).toBe("image/webp");
  });

  it("reduces encoded image size until it fits the upload limit", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 1600,
      height: 1200,
      close: vi.fn(),
    } as unknown as ImageBitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    let attempts = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      attempts += 1;
      const contents = attempts === 1 ? new Uint8Array(5 * 1024 * 1024 + 1) : new Uint8Array(8);
      callback(new Blob([contents], { type: "image/webp" }));
    });

    const output = await prepareProductImage(new File(["large"], "large.jpeg", { type: "image/jpeg" }));

    expect(attempts).toBe(2);
    expect(output.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(output.type).toBe("image/webp");
  });
});
