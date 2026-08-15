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
  /**
   * The document appears to be a scan: pages carry images but little or no
   * selectable text.
   *
   * This has to be reported loudly rather than left as a low chunk count.
   * Everything downstream — concepts, notes, questions, search — reads from
   * text, so a scanned textbook that ingests "successfully" with zero chunks
   * is invisible to the entire system while looking fine.
   */
  likelyScanned?: boolean;
}
