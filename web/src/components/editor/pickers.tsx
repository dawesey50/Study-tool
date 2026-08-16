import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, flattenSections } from '../../lib/api';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

/**
 * The two pickers behind the figure and cross-reference insert commands.
 *
 * Both deliberately offer only what is already in the module: figures come
 * from the ones ingestion pulled out of your own PDFs, and a cross-reference
 * can only point at a section that exists. Typing a URL or a section number by
 * hand would let you write a reference that looks right and resolves to
 * nothing, which is the failure this whole design is meant to avoid.
 */

export function FigurePicker({
  open,
  onClose,
  sectionId,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  sectionId: string;
  onChoose: (figure: { src: string; alt: string; caption: string; figureId: string }) => void;
}) {
  const { data: figures, isLoading } = useQuery({
    queryKey: ['section-figures', sectionId],
    queryFn: () => api.getSectionFigures(sectionId),
    enabled: open,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Place a figure"
      description="Figures pulled out of the sources mapped to this section."
      width="max-w-2xl"
      footer={
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {isLoading && <div className="skeleton h-40" />}

      {figures?.length === 0 && (
        <p className="rounded-lg border border-line px-3 py-6 text-center text-sm leading-relaxed text-muted">
          No figures are attached to this section yet. Upload some slides and map them here, and
          whatever the extractor finds shows up in this list.
        </p>
      )}

      <div className="grid max-h-96 grid-cols-3 gap-3 overflow-y-auto">
        {figures?.map((figure) => {
          const caption = figure.captionExtracted ?? figure.captionAi ?? '';
          return (
            <button
              key={figure.id}
              className="card overflow-hidden p-0 text-left transition hover:border-accent/40"
              onClick={() => {
                onChoose({
                  src: figure.url,
                  alt: figure.altText ?? caption,
                  caption,
                  figureId: figure.id,
                });
                onClose();
              }}
            >
              <img src={figure.url} alt="" className="h-24 w-full bg-canvas object-contain" />
              <span className="block px-2 py-1.5 text-2xs leading-relaxed text-muted">
                {caption || `Page ${figure.pageNo ?? '?'}`}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

export function CrossrefPicker({
  open,
  onClose,
  moduleId,
  exceptSectionId,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  moduleId: string;
  exceptSectionId: string;
  onChoose: (target: { targetSectionId: string; label: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId),
    enabled: open,
  });

  const sections = (module ? flattenSections(module.sections) : []).filter(
    (section) =>
      section.id !== exceptSectionId &&
      (section.title.toLowerCase().includes(query.toLowerCase()) ||
        section.number.startsWith(query)),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Point at another section"
      description="Instead of writing the same explanation twice, send yourself where it already lives."
      width="max-w-lg"
      footer={
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <input
        className="input"
        autoFocus
        placeholder="Find a section"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <ul className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line">
        {sections.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches that.</li>
        )}
        {sections.map((section) => (
          <li key={section.id} className="border-b border-line last:border-b-0">
            <button
              className="flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm transition hover:bg-canvas"
              onClick={() => {
                onChoose({ targetSectionId: section.id, label: section.title });
                onClose();
              }}
            >
              <span className="shrink-0 font-mono text-xs tabular-nums text-faint">
                {section.number}
              </span>
              <span className="truncate">{section.title}</span>
              <Icon name="chevronRight" size={13} className="ml-auto shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs leading-relaxed text-muted">
        The link is stored by identity, not by number, so moving either section around the tree
        renumbers the reference rather than breaking it.
      </p>
    </Modal>
  );
}
