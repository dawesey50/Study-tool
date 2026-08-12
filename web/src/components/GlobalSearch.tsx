import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SearchHit } from '../lib/api';

/**
 * Search across notes, sources, figures and section titles.
 *
 * The server runs keyword and semantic search together and merges them, so
 * this stays useful even when the embedding model is unavailable.
 */
export function GlobalSearch({ moduleId }: { moduleId: string | undefined }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(timer);
  }, [query]);

  // Cmd/Ctrl-K focuses search from anywhere, per the keyboard-driven brief.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const { data: hits, isFetching } = useQuery({
    queryKey: ['search', debounced, moduleId],
    queryFn: () => api.search({ q: debounced, ...(moduleId ? { moduleId } : {}), limit: 20 }),
    enabled: debounced.length >= 2,
  });

  const go = (hit: SearchHit) => {
    setOpen(false);
    if (hit.sectionId) navigate(`/modules/${hit.moduleId}/sections/${hit.sectionId}`);
    else navigate(`/modules/${hit.moduleId}/sources`);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search everything  ⌘K"
        className="input"
      />

      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-md border border-line bg-panel shadow-lg">
          {isFetching && !hits && <div className="px-3 py-2 text-sm text-muted">Searching…</div>}
          {hits?.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">Nothing found for “{debounced}”.</div>
          )}
          {hits?.map((hit) => (
            <button
              key={`${hit.kind}:${hit.id}`}
              onClick={() => go(hit)}
              className="block w-full border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-canvas"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{hit.title}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                  {KIND_LABELS[hit.kind]}
                </span>
              </div>
              {hit.snippet && (
                <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted">{hit.snippet}</p>
              )}
              {hit.location && <div className="mt-0.5 text-[11px] text-muted">{hit.location}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABELS: Record<SearchHit['kind'], string> = {
  chunk: 'source',
  note_block: 'note',
  figure: 'figure',
  section: 'section',
};
