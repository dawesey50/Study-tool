/** What every parser produces, regardless of input format. */
export interface ParsedBlock {
  text: string;
  pageNo?: number;
  slideNo?: number;
  /** Seconds into the recording, when the transcript carried timestamps. */
  timestamp?: number;
}

export interface ExtractedFigure {
  /** Absolute path to the written image file. */
  absolutePath: string;
  pageNo?: number;
  width: number;
  height: number;
  captionExtracted?: string;
}

export interface ParseResult {
  blocks: ParsedBlock[];
  figures: ExtractedFigure[];
  pageCount?: number;
  /** Non-fatal problems worth surfacing in the UI. */
  warnings: string[];
}
