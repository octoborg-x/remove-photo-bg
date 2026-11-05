// Node 24 ships File/Blob but not ImageData, which the mask-compositing code
// constructs. A minimal polyfill is enough for the pure-logic unit tests; the
// real canvas behaviour is exercised by the browser tests.
class ImageDataPolyfill {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  readonly colorSpace: PredefinedColorSpace = 'srgb';

  constructor(
    dataOrWidth: Uint8ClampedArray | number,
    widthOrHeight: number,
    height?: number,
  ) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(dataOrWidth * widthOrHeight * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height ?? dataOrWidth.length / 4 / widthOrHeight;
    }
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = ImageDataPolyfill as unknown as typeof ImageData;
}
