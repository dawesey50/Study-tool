import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SearchHit } from '../lib/api';
import { Icon, type IconName } from './ui/Icon';

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
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => setHighlighted(0), [debounced]);

  // Cmd/Ctrl-K focuses search from anywhere, per the keyboard-driven brief.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const { data: hits, isFetching } = useQuery({
    queryKey: ['search', debounced, moduleId],
    queryFn: () => api.search({ q: debounced, ...(moduleId ? { moduleId } : {}), limit: 20 }),
    enabled: debounced.length >= 2,
  });

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    if (hit.sectionId) navigate(`/modules/${hit.moduleId}/sections/${hit.sectionId}`);
    else navigate(`/modules/${hit.moduleId}/sources`);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!hits?.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[highlighted];
      if (hit) go(hit);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Icon
          name="search"
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search everything"
          aria-label="Search everything"
          className="input py-1.5 pl-8 pr-12 text-sm"
        />
        {query ? (
          <button
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition hover:text-ink"
            aria-label="Clear search"
          >
            <Icon name="close" size={14} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1 py-0.5 font-mono text-2xs text-faint">
            ⌘K
          </kbd>
        )}
      </div>

      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-[26rem] overflow-y-auto rounded-xl border border-line bg-raised p-1 shadow-overlay animate-scale-in">
          {isFetching && !hits && (
            <div className="px-3 py-6 text-center text-sm text-muted">Searching…</div>
          )}
          {hits?.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted">
              Nothing found for “{debounced}”.
            </div>
          )}
          {hits?.map((hit, index) => (
            <button
              key={`${hit.kind}:${hit.id}`}
              onClick={() => go(hit)}
              onMouseEnter={() => setHighlighted(index)}
              className={`flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                index === highlighted ? 'bg-accent-soft' : ''
              }`}
            >
              <Icon
                name={KIND_ICON[hit.kind]}
                size={14}
                className={`mt-0.5 ${index === highlighted ? 'text-accent' : 'text-faint'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{hit.title}</span>
                  <span className="shrink-0 text-2xs uppercase tracking-wide text-faint">
                    {KIND_LABEL[hit.kind]}
                  </span>
                </span>
                {hit.snippet && (
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted">
                    {hit.snippet}
                  </span>
                )}
                {hit.location && (
                  <span className="mt-0.5 block truncate font-mono text-2xs text-faint">
                    {hit.location}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  chunk: 'source',
  note_block: 'note',
  figure: 'figure',
  section: 'section',
};

const KIND_ICON: Record<SearchHit['kind'], IconName> = {
  chunk: 'file',
  note_block: 'notes',
  figure: 'image',
  section: 'layers',
};
