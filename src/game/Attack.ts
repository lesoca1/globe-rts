export interface Attack {
  attackerId: number;
  defenderId: number | null;
  troops: number;
  fromTileIndex: number;
  toTileIndex: number;
}

export function createAttack(
  attackerId: number,
  defenderId: number | null,
  fromTileIndex: number,
  toTileIndex: number,
  troops: number
): Attack {
  return {
    attackerId,
    defenderId,
    troops,
    fromTileIndex,
    toTileIndex,
  };
}
