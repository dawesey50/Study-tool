import fs from 'node:fs';
import path from 'node:path';
import type { ExtractedFigure, ParsedBlock, ParseResult } from './types.js';

/**
 * DOCX, for your own existing notes and for handouts distributed as Word files.
 *
 * mammoth converts to HTML rather than plain text, which is worth the extra
 * step: headings survive as headings, and embedded images come through as data
 * URIs that can be written out as real figure files.
 */
export interface DocxParseOptions {
  figureDir: string;
  figurePrefix: string;
}

export async function parseDocx(
  filePath: string,
  options: DocxParseOptions,
): Promise<ParseResult> {
  const mammoth = await import('mammoth');
  const figures: ExtractedFigure[] = [];
  const warnings: string[] = [];
  let imageIndex = 0;

  fs.mkdirSync(options.figureDir, { recursive: true });

  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        try {
          const buffer = await image.read();
          const extension = extensionFor(image.contentType);
          const filename = `${options.figurePrefix}-img${++imageIndex}.${extension}`;
          const absolutePath = path.join(options.figureDir, filename);
          fs.writeFileSync(absolutePath, buffer);
          // Word's alt text is the closest thing a DOCX has to a caption, and
          // mammoth exposes it at runtime without declaring it.
          const altText = (image as { altText?: string }).altText;
          figures.push({
            absolutePath,
            width: 0,
            height: 0,
            ...(altText ? { captionExtracted: altText } : {}),
          });
        } catch (error) {
          warnings.push(`Embedded image skipped: ${(error as Error).message}`);
        }
        // The HTML is only an intermediate representation on the way to text,
        // so the src never has to resolve to anything.
        return { src: '' };
      }),
    },
  );

  for (const message of result.messages) {
    if (message.type === 'warning') warnings.push(message.message);
  }

  return { blocks: htmlToBlocks(result.value), figures, warnings };
}

const BLOCK_TAGS = /<\/(p|h[1-6]|li|tr|div|blockquote)>/gi;

function htmlToBlocks(html: string): ParsedBlock[] {
  return html
    .replace(BLOCK_TAGS, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function extensionFor(contentType: string | undefined): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}
