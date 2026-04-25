// Loads two equirectangular Earth textures (land/sea mask + relief) and
// exposes a fast lat/lon sampler. Coordinates: lon in [-180, 180] with the
// image's left edge at -180; lat in [-90, 90] with the image's top at +90.

export interface EarthMap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EarthData {
  water: EarthMap;
  topology: EarthMap;
}

async function loadMap(url: string): Promise<EarthMap> {
  const img = new Image();
  img.src = url;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  return {
    data: imageData.data,
    width: canvas.width,
    height: canvas.height,
  };
}

export async function loadEarthData(): Promise<EarthData> {
  const [water, topology] = await Promise.all([
    loadMap("earth-water.png"),
    loadMap("earth-topology.png"),
  ]);
  return { water, topology };
}

/** Sample the red channel at (lonDeg, latDeg). Wraps in longitude, clamps lat. */
export function sample(map: EarthMap, lonDeg: number, latDeg: number): number {
  // U is inverted: viewing the sphere from outside, east on the texture
  // (right) corresponds to the -Z hemisphere, so we flip lon to keep the
  // continents from rendering as their mirror image.
  let u = (180 - lonDeg) / 360;
  u = u - Math.floor(u); // wrap
  let v = (90 - latDeg) / 180;
  if (v < 0) v = 0;
  else if (v > 1) v = 1;

  const px = Math.min(map.width - 1, Math.floor(u * map.width));
  const py = Math.min(map.height - 1, Math.floor(v * map.height));
  return map.data[(py * map.width + px) * 4];
}
