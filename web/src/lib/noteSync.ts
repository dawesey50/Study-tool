/**
 * The two decisions behind NoteEditor's autosave that used to be tangled
 * into refs and closures directly in the component — pulled out here because
 * that was exactly where a real, live bug hid: a save left running when the
 * user switched sections could gate or rerun against the wrong one, and a
 * stale "already loaded" flag could freeze serverBlocks forever the moment
 * anything besides a plain edit changed a section's notes. Both were wrong
 * in ways no amount of staring at the component made obvious, and neither
 * needs a rendered editor to get right — they're just decisions over plain
 * values, which is what actually let them be tested.
 */

/** A NoteBlock, reduced to the fields that matter for "did the server's copy actually change". */
export interface ComparableBlock {
  id: string;
  markdown: string;
  type: string;
  locked: boolean;
  figureId: string | null;
  targetSectionId: string | null;
}

/** Order matters: a reorder is a real change even when every block's own content is untouched. */
export function blocksChanged(previous: ComparableBlock[], next: ComparableBlock[]): boolean {
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i++) {
    const a = previous[i]!;
    const b = next[i]!;
    if (
      a.id !== b.id ||
      a.markdown !== b.markdown ||
      a.type !== b.type ||
      a.locked !== b.locked ||
      a.figureId !== b.figureId ||
      a.targetSectionId !== b.targetSectionId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the editor's visible document should be reloaded from fresh server
 * blocks. Skipping it is only justified by one of two things: unsaved local
 * edits still in the document (reloading would erase them under a cursor
 * still typing), or the server not actually having changed (reloading would
 * just reset the cursor for nothing — including after this same save's own
 * end-of-batch refetch, which redelivers blocks whether or not they moved).
 */
export function shouldReloadVisibleContent(params: {
  alreadyLoadedThisSection: boolean;
  hasUnsavedLocalEdits: boolean;
  serverBlocksChanged: boolean;
}): boolean {
  if (!params.alreadyLoadedThisSection) return true;
  if (params.hasUnsavedLocalEdits) return false;
  return params.serverBlocksChanged;
}

/**
 * Keeps at most one save running per key (a section id), and queues a rerun
 * — rather than a second concurrent run — for any call that arrives while
 * one is already in flight for that same key. A concurrent second run is
 * exactly what used to diff against the same stale state as the first and
 * try to create the same new block twice, failing the second attempt on a
 * duplicate key. Keying by section, rather than one flag for the whole
 * component, is what stops a save still running for a section just
 * navigated away from from gating or rerunning against the one navigated to
 * — this component doesn't remount between sections, only its editor does.
 */
export interface SaveGate {
  /** True if the caller may proceed now; false if a rerun was queued instead. */
  tryEnter(key: string): boolean;
  /** Call when a save for `key` finishes. True means a rerun was queued and should run now. */
  exit(key: string): boolean;
}

export function createSaveGate(): SaveGate {
  const running = new Set<string>();
  const rerunQueued = new Set<string>();
  return {
    tryEnter(key: string): boolean {
      if (running.has(key)) {
        rerunQueued.add(key);
        return false;
      }
      running.add(key);
      return true;
    },
    exit(key: string): boolean {
      running.delete(key);
      if (rerunQueued.has(key)) {
        rerunQueued.delete(key);
        return true;
      }
      return false;
    },
  };
}
