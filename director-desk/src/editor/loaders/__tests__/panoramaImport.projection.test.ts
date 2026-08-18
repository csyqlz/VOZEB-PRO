import * as panoramaImport from "../panoramaImport";

const { blendPanoramaSeamPixels, softenPanoramaPolePixels } = panoramaImport;

function pixelAt(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  const index = (y * width + x) * 4;
  return Array.from(pixels.slice(index, index + 4));
}

it("blends the left and right panorama edges so the sphere seam closes cleanly", () => {
  const width = 6;
  const height = 1;
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255,
    20, 20, 20, 255,
    40, 40, 40, 255,
    160, 160, 160, 255,
    180, 180, 180, 255,
    240, 240, 240, 255,
  ]);

  const result = blendPanoramaSeamPixels(pixels, width, height, 2);

  expect(pixelAt(result, width, 0, 0)).toEqual(pixelAt(result, width, width - 1, 0));
});

it("relocates the sphere seam to a low-contrast cut inside the image before wrapping", () => {
  const seamRelocator = (panoramaImport as Record<string, unknown>).relocatePanoramaSeamPixels as
    | ((pixels: Uint8ClampedArray, width: number, height: number) => Uint8ClampedArray)
    | undefined;

  expect(typeof seamRelocator).toBe("function");

  const width = 6;
  const height = 2;
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255,
    40, 0, 0, 255,
    180, 0, 0, 255,
    182, 0, 0, 255,
    220, 0, 0, 255,
    250, 0, 0, 255,
    0, 0, 0, 255,
    40, 0, 0, 255,
    180, 0, 0, 255,
    182, 0, 0, 255,
    220, 0, 0, 255,
    250, 0, 0, 255,
  ]);

  const result = seamRelocator!(pixels, width, height);

  expect(pixelAt(result, width, 0, 0)).toEqual(pixelAt(pixels, width, 3, 0));
  expect(pixelAt(result, width, width - 1, 0)).toEqual(pixelAt(pixels, width, 2, 0));
});

it("softens the top and bottom pole rows to avoid starburst distortion", () => {
  const width = 4;
  const height = 6;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let x = 0; x < width; x += 1) {
    const topIndex = x * 4;
    pixels[topIndex] = x * 60;
    pixels[topIndex + 1] = 0;
    pixels[topIndex + 2] = 0;
    pixels[topIndex + 3] = 255;

    const bottomIndex = ((height - 1) * width + x) * 4;
    pixels[bottomIndex] = 0;
    pixels[bottomIndex + 1] = x * 50;
    pixels[bottomIndex + 2] = 0;
    pixels[bottomIndex + 3] = 255;
  }

  const result = softenPanoramaPolePixels(pixels, width, height, 2);

  expect(pixelAt(result, width, 0, 0)).toEqual(pixelAt(result, width, width - 1, 0));
  expect(pixelAt(result, width, 0, height - 1)).toEqual(pixelAt(result, width, width - 1, height - 1));
});
