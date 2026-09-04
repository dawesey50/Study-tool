import fs from 'node:fs';

/**
 * What a file actually is, rather than what it is called.
 *
 * WHY THIS EXISTS
 *
 * A university VLE served a lecture as `Cell Signaling 1_2025_26_Slides.ppt`
 * and it was rejected as an unsupported type. Two different things hide behind
 * that name and they need opposite responses:
 *
 *   - a modern .pptx that someone saved, or a server delivered, under the old
 *     extension. Extremely common, perfectly readable, and rejecting it is
 *     pure loss.
 *   - a genuinely old binary PowerPoint file, which is an OLE compound
 *     document and cannot be read by anything here.
 *
 * The extension cannot tell them apart. The first four bytes can: every Office
 * file since 2007 is a ZIP and starts `PK\x03\x04`, and every file before it
 * is a compound binary starting `D0 CF 11 E0`.
 *
 * So a `.ppt` upload is opened rather than refused, and only the genuinely old
 * ones are turned away — with the fix named, because "unsupported file type"
 * leaves a student with thirty lectures and nowhere to go.
 */

export type ContainerKind =
  /** A ZIP: every Office format since 2007, whatever it is called. */
  | 'ooxml'
  /** An OLE compound document: Office before 2007. */
  | 'ole'
  | 'pdf'
  | 'other';

const MAGIC: Array<{ kind: ContainerKind; bytes: number[] }> = [
  { kind: 'ooxml', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'ole', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** Reads the first few bytes only — this runs on files of several hundred MB. */
export function containerKind(filePath: string): ContainerKind {
  let handle: number | null = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    const read = fs.readSync(handle, header, 0, 8, 0);
    if (read < 4) return 'other';

    for (const { kind, bytes } of MAGIC) {
      if (bytes.every((byte, index) => header[index] === byte)) return kind;
    }
    return 'other';
  } catch {
    return 'other';
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

export interface Verdict {
  /** The extension the file should be treated as, whatever it is called. */
  effectiveExtension: string;
  /** Set when the file cannot be read at all, with the fix rather than a shrug. */
  refuse?: string;
  /** Set when the name lied and we went with the bytes. Worth telling the user. */
  note?: string;
}

/**
 * What to do with an uploaded file, given its name and its first bytes.
 *
 * Called after the file is on disk but before anything else looks at it, so a
 * misnamed file is fixed once, here, rather than confusing every stage after.
 */
export function resolveFormat(filePath: string, extension: string): Verdict {
  const lower = extension.toLowerCase();
  const kind = containerKind(filePath);

  // --- the old binary Office formats ---------------------------------------
  if (lower === '.ppt' || lower === '.doc' || lower === '.xls') {
    if (kind === 'ooxml') {
      // The name lied, and in our favour. This is the common case with files
      // served by a VLE or saved by someone who typed the extension by hand.
      const modern = `${lower}x`;
      return {
        effectiveExtension: modern,
        note:
          `Named "${lower}" but it is really a ${modern} file, so it was read as one. ` +
          'Nothing is wrong with it.',
      };
    }

    const app = lower === '.doc' ? 'Word' : lower === '.xls' ? 'Excel' : 'PowerPoint';
    return {
      effectiveExtension: lower,
      refuse:
        `"${lower}" is the pre-2007 binary Office format, which cannot be read. ` +
        `Open it in ${app} and use File → Save As, choosing "${app} Presentation (.${
          lower === '.ppt' ? 'pptx' : lower === '.doc' ? 'docx' : 'xlsx'
        })". ` +
        'For a whole folder at once, open one file, then File → Info → Convert, or use ' +
        'LibreOffice: soffice --headless --convert-to pptx *.ppt',
    };
  }

  // --- a modern Office extension that is not actually one ------------------
  if ((lower === '.pptx' || lower === '.docx') && kind === 'ole') {
    const old = lower.slice(0, -1);
    return {
      effectiveExtension: lower,
      refuse:
        `This is named "${lower}" but is really an old "${old}" binary file inside. ` +
        'Open it and use File → Save As to write a genuine ' +
        `${lower} — renaming the file alone does not convert it.`,
    };
  }

  // A PDF that is really a PDF, a text file, anything else: trust the name.
  return { effectiveExtension: lower };
}
