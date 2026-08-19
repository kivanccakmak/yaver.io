export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

export function decodePng(input: Buffer | ArrayBuffer | Uint8Array): DecodedPng;

export function samplePixels(
  image: DecodedPng,
  samplePoints: (width: number, height: number, stride?: number) => Array<[number, number]>,
  stride?: number,
): number[][];
