import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type SectionMastery } from '../lib/api';
import { Icon } from '../components/ui/Icon';

/**
 * What is due, and how well the module is actually known.
 *
 * The number this page exists to get right is mastery, and the way to get it
 * wrong is to average only what has been tested. A section with fifty concepts
 * of which nine have been seen, all answered correctly, is not 100% mastered —
 * it is 18% at best, and printing 100% would be the single most misleading
 * thing the system could tell you the week before an exam. So every count here
 * is out of the whole, and the untested show as untested.
 *
 * Misconceptions are given their own place rather than being mixed into the
 * due list, because the right response is different. A due concept wants
 * another question. Something you are confidently wrong about wants you to go
 * back and read: drilling a belief only rehearses it.
 */
export function RevisionPage() {
  const { moduleId } = useParams<{ moduleId: string }>();

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['revision', moduleId],
    queryFn: () => api.getRevision(moduleId!),
    enabled: Boolean(moduleId),
  });

  if (isLoading) return <div className="p-6"><div className="skeleton h-64" /></div>;

  const summary = data;
  const untested = summary ? summary.concepts - summary.reviewed : 0;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}`}>
            {module?.title ?? 'Module'}
          </Link>
          <h1 className="text-lg font-semibold">Revision</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Scheduled per concept rather than per question, so what comes due is the idea and
            the question is drawn fresh. A concept you have never been tested on counts as
            unknown, not as known.
          </p>
        </div>
        {summary && summary.due > 0 && (
          <Link className="btn btn-primary shrink-0" to={`/modules/${moduleId}/practice`}>
            <Icon name="question" className="mr-1 h-4 w-4" />
            Practise {summary.due} due
          </Link>
        )}
      </div>

      {!summary || summary.concepts === 0 ? (
        <div className="card mt-6 p-6 text-center text-sm text-muted">
          No concepts in this module yet. Extract them from a section's Concepts tab — the
          schedule is built on concepts, so there is nothing to revise until they exist.
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Concepts" value={String(summary.concepts)} />
            <Stat
              label="Ever tested"
              value={`${summary.reviewed}`}
              hint={untested > 0 ? `${untested} never seen` : undefined}
            />
            <Stat
              label="Due now"
              value={String(summary.due)}
              hint={
                summary.dueOverdue > 0
                  ? `${summary.dueOverdue} overdue, ${summary.dueNew} new`
                  : undefined
              }
            />
            <Stat
              label="Mastery"
              value={`${Math.round(summary.mastery * 100)}%`}
              hint="across every concept"
            />
          </div>

          {summary.reviewed > 0 && summary.reviewed < summary.concepts / 4 && (
            <p className="mt-3 rounded-md border border-line bg-panel p-3 text-xs leading-relaxed text-muted">
              Only {summary.reviewed} of {summary.concepts} concepts have ever been tested, so
              the mastery figure is mostly measuring how much you have not started. It becomes
              meaningful once most of the module has been seen at least once.
            </p>
          )}

          {/* --- misconceptions ---------------------------------------- */}
          {summary.misconceptions.length > 0 && (
            <div className="card mt-5 border-amber-500/40 p-4">
              <h2 className="text-sm font-semibold">
                Things you are confident about and have wrong
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Answered wrongly while you were sure. These are worth more of your time than
                anything you guessed at, and the answer to them is to read the section again
                rather than to be asked again — drilling a belief only rehearses it.
              </p>
              <ul className="mt-3 space-y-2">
                {summary.misconceptions.map((concept) => (
                  <li key={concept.conceptId} className="text-sm">
                    <Link
                      className="hover:underline"
                      to={`/modules/${moduleId}/sections/${concept.sectionId}`}
                    >
                      {concept.statement}
                    </Link>
                    <span className="ml-2 text-xs text-muted">
                      {concept.sectionPath} · {concept.confidentlyWrong}×
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* --- per section ------------------------------------------- */}
          <h2 className="mt-6 text-sm font-semibold uppercase tracking-wider text-muted">
            By section
          </h2>
          <ul className="mt-3 space-y-1.5">
            {summary.sections.map((section) => (
              <SectionRow key={section.sectionId} section={section} moduleId={moduleId!} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-tight text-muted">{hint}</p>}
    </div>
  );
}

function SectionRow({ section, moduleId }: { section: SectionMastery; moduleId: string }) {
  // A parent section is shown by its subtree, since its own three concepts say
  // nothing about the twenty beneath it.
  const stats = section.subtree.concepts > section.concepts ? section.subtree : section;
  const percent = Math.round(stats.mastery * 100);
  const depth = (section.sectionPath.match(/\./g) ?? []).length;

  return (
    <li className="card p-3" style={{ marginLeft: `${Math.max(0, depth - 1) * 16}px` }}>
      <div className="flex items-center justify-between gap-3">
        <Link
          className="min-w-0 flex-1 truncate text-sm hover:underline"
          to={`/modules/${moduleId}/sections/${section.sectionId}`}
        >
          {section.sectionPath}
        </Link>
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {stats.reviewed}/{stats.concepts} seen
          {stats.due > 0 && <span className="ml-2 text-accent">{stats.due} due</span>}
          {stats.confidentlyWrong > 0 && (
            <span className="ml-2 text-amber-500">{stats.confidentlyWrong} wrong-and-sure</span>
          )}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted">
          {percent}%
        </span>
      </div>
    </li>
  );
}
