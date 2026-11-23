export declare const SMUFL_TEXT_RANGES: ReadonlyArray<readonly [number, number]>;

/** Code point to outline path data, in font units. */
export declare function harvestSmuflTextGlyphs(): Promise<Map<number, string>>;

/** Renders the generated module for a harvested outline table. */
export declare function renderSmuflTextGlyphModule(outlines: Map<number, string>): string;
