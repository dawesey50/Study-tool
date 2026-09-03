import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, flattenSections, type AttemptResult, type PracticeQuestion } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { useToast } from '../components/ui/Toast';

/**
 * Practice — one question at a time, answer then reveal.
 *
 * Two things here are deliberate rather than incidental.
 *
 * The confidence rating is asked before the answer is revealed, and it is not
 * optional. Asked afterwards it would be a memory of how you felt, which is
 * worthless; asked before, it produces the confident-and-wrong signal that
 * §8 treats as the most important thing the system learns about you. That is
 * also why it is a required click rather than a slider defaulted to the
 * middle: a default would be answered by the interface rather than by you.
 *
 * The answer is not in the page until you have submitted. The server withholds
 * it, so there is nothing to find in devtools and no honesty system to keep to.
 */
export function PracticePage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const [params] = useSearchParams();
  const sectionId = params.get('section') ?? undefined;
  const queryClient = useQueryClient();
  const toast = useToast();

  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [written, setWritten] = useState('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [tally, setTally] = useState({ right: 0, wrong: 0, unmarked: 0, confidentlyWrong: 0 });

  const startedAt = useRef(Date.now());

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['practice', moduleId, sectionId],
    queryFn: () => api.getPractice(moduleId!, { count: 10, ...(sectionId ? { sectionId } : {}) }),
    enabled: Boolean(moduleId),
    // A fresh set every time this page is opened, not a cached one from
    // yesterday with the questions you have already done.
    staleTime: 0,
    gcTime: 0,
  });

  const questions = data?.questions ?? [];
  const question: PracticeQuestion | undefined = questions[index];

  useEffect(() => {
    startedAt.current = Date.now();
  }, [index]);

  const submit = useMutation({
    mutationFn: () =>
      api.submitAttempt(question!.id, {
        ...(chosen !== null ? { optionIndex: chosen } : {}),
        ...(written.trim() ? { text: written.trim() } : {}),
        ...(confidence !== null ? { confidence } : {}),
        secondsTaken: (Date.now() - startedAt.current) / 1000,
      }),
    onSuccess: (attempt) => {
      setResult(attempt);
      setTally((previous) => ({
        right: previous.right + (attempt.correct === true ? 1 : 0),
        wrong: previous.wrong + (attempt.correct === false ? 1 : 0),
        unmarked: previous.unmarked + (attempt.correct === null ? 1 : 0),
        confidentlyWrong: previous.confidentlyWrong + (attempt.confidentlyWrong ? 1 : 0),
      }));
      queryClient.invalidateQueries({ queryKey: ['questions', moduleId] });
    },
    onError: (error: Error) => toast.error('Could not record that answer', error.message),
  });

  const markWritten = useMutation({
    mutationFn: (correct: boolean) => api.markAttempt(result!.attemptId, correct),
    onSuccess: (marked) => {
      setTally((previous) => ({
        ...previous,
        unmarked: Math.max(0, previous.unmarked - 1),
        right: previous.right + (marked.correct ? 1 : 0),
        wrong: previous.wrong + (marked.correct ? 0 : 1),
      }));
      setResult((previous) => (previous ? { ...previous, correct: marked.correct } : previous));
    },
    onError: (error: Error) => toast.error('Could not save that mark', error.message),
  });

  /**
   * Answering thirty questions a day with a mouse is a reason to stop doing
   * it, so the whole loop is reachable from the keyboard: a number or letter
   * picks an option, 1–5 sets confidence, Enter submits and then advances.
   *
   * Deliberately inert while a text box has focus — a written answer contains
   * digits, and having "3" jump the confidence rating mid-sentence would make
   * the feature actively hostile.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!question) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        if (result) next();
        else if (canSubmit && !submit.isPending) submit.mutate();
        return;
      }
      if (result) return;

      const isMcqNow = question.options.length > 0;

      // Letters pick an option; digits set confidence. They cannot collide,
      // which is why the two use different keys rather than sharing 1-5.
      const letter = event.key.toLowerCase();
      if (isMcqNow && letter >= 'a' && letter <= 'z') {
        const index = letter.charCodeAt(0) - 97;
        if (index < question.options.length) {
          event.preventDefault();
          setChosen(index);
        }
        return;
      }

      if (event.key >= '1' && event.key <= '5') {
        event.preventDefault();
        setConfidence(Number(event.key));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const next = () => {
    setChosen(null);
    setWritten('');
    setConfidence(null);
    setResult(null);
    setIndex((previous) => previous + 1);
  };

  const restart = async () => {
    setIndex(0);
    setChosen(null);
    setWritten('');
    setConfidence(null);
    setResult(null);
    setTally({ right: 0, wrong: 0, unmarked: 0, confidentlyWrong: 0 });
    await refetch();
  };

  const sections = module ? flattenSections(module.sections) : [];
  const sectionName = sectionId
    ? sections.find((node) => node.id === sectionId)
    : undefined;

  if (isLoading) return <div className="p-6"><div className="skeleton h-64" /></div>;

  if (questions.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Header moduleId={moduleId!} title={module?.title} sectionTitle={sectionName?.title} />
        <div className="card mt-6 p-6 text-center">
          <p className="text-sm text-muted">
            No questions in this module yet. Generate some from the question bank — they are
            sampled from the concept list, so the concepts have to exist first.
          </p>
          <Link className="btn btn-primary mt-4 inline-flex" to={`/modules/${moduleId}/questions`}>
            Go to the question bank
          </Link>
        </div>
      </div>
    );
  }

  // --- the end of the set --------------------------------------------------
  if (!question) {
    const answered = tally.right + tally.wrong;
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Header moduleId={moduleId!} title={module?.title} sectionTitle={sectionName?.title} />
        <div className="card mt-6 p-6">
          <h2 className="text-lg font-semibold">
            {answered > 0 ? `${tally.right} of ${answered}` : 'Set finished'}
          </h2>
          {tally.unmarked > 0 && (
            <p className="mt-1 text-sm text-muted">
              {tally.unmarked} written answer{tally.unmarked === 1 ? '' : 's'} left unmarked.
            </p>
          )}
          {tally.confidentlyWrong > 0 && (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <strong>{tally.confidentlyWrong}</strong> answered wrongly while you were sure of
              it. Those are the ones worth going back to first — a thing you believe and have
              wrong costs more than a thing you know you do not know.
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <button className="btn btn-primary" onClick={restart}>
              Another set
            </button>
            <Link className="btn" to={`/modules/${moduleId}/questions`}>
              Question bank
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isMcq = question.options.length > 0;
  const canSubmit =
    confidence !== null && (isMcq ? chosen !== null : written.trim().length > 0);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Header moduleId={moduleId!} title={module?.title} sectionTitle={sectionName?.title} />

      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <span>
          Question {index + 1} of {questions.length}
        </span>
        <span className="truncate pl-4">{question.sectionPaths.join(' · ')}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full bg-accent transition-[width] duration-300"
          style={{ width: `${(index / questions.length) * 100}%` }}
        />
      </div>

      <div className="card mt-4 p-5">
        <p className="text-[15px] leading-relaxed">{question.stem}</p>

        {/*
          The figure the question depends on. Without it a data-interpretation
          question asks what a trace shows with no trace, which is not merely
          unhelpful — it is unanswerable, and getting it wrong would feed a
          false signal into the schedule.
        */}
        {question.figure && (
          <figure className="mt-4">
            <img
              src={question.figure.url}
              alt={question.figure.caption ?? 'Figure this question refers to'}
              className="max-h-96 w-full rounded-lg border border-line object-contain"
            />
            {question.figure.caption && (
              <figcaption className="mt-1.5 text-xs text-muted">
                {question.figure.caption}
              </figcaption>
            )}
          </figure>
        )}
        {question.bloomLevel && (
          <span className="mt-3 inline-block rounded bg-line px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted">
            {question.bloomLevel}
          </span>
        )}

        {isMcq ? (
          <ul className="mt-4 space-y-2">
            {question.options.map((option, optionIndex) => {
              const isChosen = chosen === optionIndex;
              const isKey = result?.correctIndex === optionIndex;
              const tone = !result
                ? isChosen
                  ? 'border-accent bg-accent/10'
                  : 'border-line hover:border-muted'
                : isKey
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : isChosen
                    ? 'border-rose-500 bg-rose-500/10'
                    : 'border-line opacity-60';

              return (
                <li key={optionIndex}>
                  <button
                    className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${tone}`}
                    disabled={Boolean(result)}
                    onClick={() => setChosen(optionIndex)}
                  >
                    <span
                      className="mr-2 font-mono text-xs text-muted"
                      title={`Press ${String.fromCharCode(97 + optionIndex)}`}
                    >
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    {option}
                    {/* Why a distractor is wrong is the part that teaches. */}
                    {result?.options?.[optionIndex]?.whyWrong && !isKey && (
                      <span className="mt-1.5 block text-xs italic text-muted">
                        {result.options[optionIndex]!.whyWrong}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <textarea
            className="input mt-4 min-h-32 w-full font-normal"
            placeholder="Write your answer, then reveal the mark scheme and mark yourself."
            value={written}
            onChange={(event) => setWritten(event.target.value)}
            disabled={Boolean(result)}
          />
        )}
      </div>

      {/* --- confidence, asked before the reveal ----------------------- */}
      {!result && (
        <div className="card mt-3 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">
            How sure are you?
          </p>
          <p className="mt-1 text-xs text-muted">
            Asked now rather than after, because afterwards it is a memory of how you felt.
            Being sure and wrong is the single most useful thing this can learn about you.
          </p>
          <p className="mt-1 text-[11px] text-faint">
            Keys: a–d choose · 1–5 how sure · Enter answers, then moves on
          </p>
          <div className="mt-3 flex gap-1.5">
            {CONFIDENCE.map((level) => (
              <button
                key={level.value}
                className={`flex-1 rounded-md border px-2 py-2 text-xs transition-colors ${
                  confidence === level.value
                    ? 'border-accent bg-accent/10 font-medium'
                    : 'border-line hover:border-muted'
                }`}
                onClick={() => setConfidence(level.value)}
                title={`${level.hint}  (press ${level.value})`}
              >
                {level.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* --- the reveal ------------------------------------------------- */}
      {result && (
        <div className="card mt-3 p-5">
          {result.marked ? (
            <p
              className={`text-sm font-semibold ${
                result.correct ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              {result.correct ? 'Correct' : 'Not right'}
            </p>
          ) : result.correct === null ? (
            <div>
              <p className="text-sm font-semibold">Mark yourself</p>
              <p className="mt-1 text-xs text-muted">
                Written answers are not marked automatically. Guessing at it would put invented
                data into your revision schedule, which is worse than asking.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="btn btn-sm"
                  onClick={() => markWritten.mutate(true)}
                  disabled={markWritten.isPending}
                >
                  I got it
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => markWritten.mutate(false)}
                  disabled={markWritten.isPending}
                >
                  I did not
                </button>
              </div>
            </div>
          ) : (
            <p
              className={`text-sm font-semibold ${
                result.correct ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              Marked as {result.correct ? 'correct' : 'wrong'}
            </p>
          )}

          {result.confidentlyWrong && (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              You were sure, and it was wrong. That is worth more of your revision time than
              anything you guessed at — it means the thing you believe is the thing to fix.
            </p>
          )}

          {result.correctAnswer && (
            <p className="mt-4 text-sm">
              <span className="text-xs uppercase tracking-wider text-muted">Answer</span>
              <br />
              {result.correctAnswer}
            </p>
          )}
          {result.workedAnswer && (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-wider text-muted">Reasoning</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                {result.workedAnswer}
              </p>
            </div>
          )}
          {result.markScheme && (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-wider text-muted">Mark scheme</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                {result.markScheme}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted">
          {tally.right} right · {tally.wrong} wrong
          {tally.unmarked > 0 ? ` · ${tally.unmarked} unmarked` : ''}
        </span>
        {result ? (
          <button className="btn btn-primary" onClick={next}>
            {index + 1 < questions.length ? 'Next question' : 'Finish'}
            <Icon name="chevronRight" className="ml-1 h-4 w-4" />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => submit.mutate()}
            disabled={!canSubmit || submit.isPending}
            title={
              confidence === null
                ? 'Say how sure you are first'
                : canSubmit
                  ? ''
                  : 'Answer the question first'
            }
          >
            {submit.isPending ? 'Recording…' : 'Answer'}
          </button>
        )}
      </div>
    </div>
  );
}

const CONFIDENCE = [
  { value: 1, label: 'Guessing', hint: 'No idea — this was a coin toss' },
  { value: 2, label: 'Unsure', hint: 'A hunch, nothing more' },
  { value: 3, label: 'Fairly', hint: 'I think so' },
  { value: 4, label: 'Confident', hint: 'I am fairly certain' },
  { value: 5, label: 'Certain', hint: 'I would bet on this' },
];

function Header({
  moduleId,
  title,
  sectionTitle,
}: {
  moduleId: string;
  title?: string;
  sectionTitle?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}`}>
          {title ?? 'Module'}
        </Link>
        <h1 className="truncate text-lg font-semibold">
          Practice{sectionTitle ? ` · ${sectionTitle}` : ''}
        </h1>
      </div>
      <Link className="btn btn-sm shrink-0" to={`/modules/${moduleId}/questions`}>
        <Icon name="layers" className="mr-1 h-4 w-4" />
        Bank
      </Link>
    </div>
  );
}
