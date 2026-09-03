import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, flattenSections, type ExamResult } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/Confirm';
import { useToast } from '../components/ui/Toast';

/**
 * Timed exams — §9.
 *
 * Three things make this a mock rather than practice with a clock on it, and
 * all three are visible in this file.
 *
 * The whole paper is on one page. You can look ahead, skip, come back and
 * change your mind, which is what you do in an exam and what
 * question-at-a-time practice makes impossible.
 *
 * Nothing is marked until you submit. Immediate feedback is what makes
 * practice useful and it is also what stops it measuring anything: knowing you
 * got question three right changes how you answer question four. The server
 * enforces this — the answers are not in the page to be found.
 *
 * The score at the end is over what could be marked, and says what it could
 * not. Most of a real paper is prose, prose needs a mark scheme, and past
 * papers do not ship one. A percentage that quietly ignored two thirds of the
 * paper would read as a result and be a fiction.
 */
export function ExamsPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [questionCount, setQuestionCount] = useState(15);
  const [minutes, setMinutes] = useState(45);
  const [pastPaperShare, setPastPaperShare] = useState(0.4);
  const [sectionId, setSectionId] = useState('');

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['exams', moduleId],
    queryFn: () => api.listExams(moduleId!),
    enabled: Boolean(moduleId),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createExam(moduleId!, {
        questionCount,
        minutes,
        pastPaperShare,
        ...(sectionId ? { sectionIds: [sectionId] } : {}),
      }),
    onSuccess: (exam) => {
      queryClient.invalidateQueries({ queryKey: ['exams', moduleId] });
      navigate(`/modules/${moduleId}/exams/${exam.id}`);
    },
    onError: (error: Error) => toast.error('Could not build a paper', error.message),
  });

  const remove = useMutation({
    mutationFn: (examId: string) => api.deleteExam(examId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exams', moduleId] }),
    onError: (error: Error) => toast.error('Could not delete that paper', error.message),
  });

  const sections = module ? flattenSections(module.sections) : [];
  const exams = data?.exams ?? [];

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="min-w-0">
        <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}`}>
          {module?.title ?? 'Module'}
        </Link>
        <h1 className="text-lg font-semibold">Mock exams</h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
          A whole paper at once, on the clock, marked only when you submit. Real past-paper
          questions go in first and generated ones fill the rest — a mock built only from this
          system’s own questions measures how well you do on this system’s questions.
        </p>
      </div>

      <div className="card mt-5 p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-xs text-muted">
            Questions
            <input
              className="input mt-1 block w-full"
              type="number"
              min={1}
              max={100}
              value={questionCount}
              onChange={(event) => setQuestionCount(Number(event.target.value) || 1)}
            />
          </label>
          <label className="text-xs text-muted">
            Minutes
            <input
              className="input mt-1 block w-full"
              type="number"
              min={5}
              max={300}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value) || 5)}
            />
          </label>
          <label className="text-xs text-muted">
            Real questions
            <select
              className="input mt-1 block w-full"
              value={pastPaperShare}
              onChange={(event) => setPastPaperShare(Number(event.target.value))}
            >
              <option value={0}>None</option>
              <option value={0.25}>A quarter</option>
              <option value={0.4}>Two fifths</option>
              <option value={0.6}>Three fifths</option>
              <option value={1}>As many as possible</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            From
            <select
              className="input mt-1 block w-full"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
            >
              <option value="">Whole module</option>
              {sections.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.number} {node.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="btn btn-primary mt-3"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          <Icon name="file" className="mr-1 h-4 w-4" />
          {create.isPending ? 'Building…' : 'Build a paper'}
        </button>
      </div>

      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wider text-muted">Papers</h2>
      {isLoading ? (
        <div className="skeleton mt-3 h-24" />
      ) : exams.length === 0 ? (
        <p className="card mt-3 p-6 text-center text-sm text-muted">
          No papers yet. Build one above — it needs questions in the bank, either generated or
          extracted from a past paper.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {exams.map((exam) => (
            <li key={exam.id} className="card flex items-center gap-3 p-3">
              <Link
                className="min-w-0 flex-1"
                to={`/modules/${moduleId}/exams/${exam.id}`}
              >
                <p className="truncate text-sm font-medium">{exam.title}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {exam.questionCount} questions · {exam.minutes} min ·{' '}
                  {exam.submittedAt
                    ? exam.score !== null
                      ? `${Math.round(exam.score * 100)}% of what could be marked`
                      : 'submitted, nothing auto-markable'
                    : exam.startedAt
                      ? 'in progress'
                      : 'not started'}
                </p>
              </Link>
              <button
                className="btn btn-sm shrink-0"
                aria-label="Delete this paper"
                title="Delete this paper"
                onClick={async () => {
                  const confirmed = await confirm({
                    title: 'Delete this paper?',
                    message: 'Its answers stay in your attempt history and revision schedule.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  });
                  if (confirmed) remove.mutate(exam.id);
                }}
              >
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sitting one
// ---------------------------------------------------------------------------

export function ExamPage() {
  const { moduleId, examId } = useParams<{ moduleId: string; examId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [answers, setAnswers] = useState<
    Record<string, { optionIndex?: number; text?: string; confidence?: number }>
  >({});
  const [result, setResult] = useState<ExamResult | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { data: exam, isLoading } = useQuery({
    queryKey: ['exam', examId],
    queryFn: () => api.startExam(examId!),
    enabled: Boolean(examId),
    // The paper is fixed once drawn; refetching would only risk resetting
    // answers typed but not yet submitted.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const submitted = useRef(false);

  const submit = useMutation({
    mutationFn: () =>
      api.submitExam(
        examId!,
        (exam?.questions ?? []).map((question) => ({
          questionId: question.id,
          ...answers[question.id],
        })),
      ),
    onSuccess: (marked) => {
      submitted.current = true;
      setResult(marked);
      queryClient.invalidateQueries({ queryKey: ['exams', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['revision', moduleId] });
    },
    onError: (error: Error) => toast.error('Could not submit', error.message),
  });

  // The clock. Ticking every second rather than every minute so the last
  // minute of a paper feels like the last minute of a paper.
  useEffect(() => {
    if (result || !exam?.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [exam?.startedAt, result]);

  const total = (exam?.blueprint.minutes ?? 45) * 60;
  const elapsed = exam?.startedAt ? Math.floor(now / 1000) - exam.startedAt : 0;
  const remaining = Math.max(0, total - elapsed);
  const outOfTime = remaining === 0;

  /**
   * Time runs out and the paper goes in as it stands.
   *
   * The alternative — a banner saying time is up, leaving you to press submit —
   * is not a time limit, and the whole reason to sit a timed paper is to find
   * out what you can do inside the time.
   */
  useEffect(() => {
    if (!outOfTime || result || submitted.current || !exam || submit.isPending) return;
    submitted.current = true;
    submit.mutate();
  }, [outOfTime, result, exam, submit]);

  if (isLoading || !exam) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="skeleton h-64" />
      </div>
    );
  }

  if (result) return <ExamResults moduleId={moduleId!} result={result} />;

  const answered = Object.keys(answers).filter(
    (id) => answers[id]?.optionIndex !== undefined || answers[id]?.text?.trim(),
  ).length;

  return (
    <div className="mx-auto max-w-3xl p-6 pb-32">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}/exams`}>
            Mock exams
          </Link>
          <h1 className="truncate text-lg font-semibold">{exam.title}</h1>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`font-mono text-2xl tabular-nums ${
              remaining < 300 ? 'text-rose-500' : ''
            }`}
          >
            {formatClock(remaining)}
          </p>
          <p className="text-xs text-muted">
            {answered}/{exam.questions.length} answered
          </p>
        </div>
      </div>

      <ol className="mt-6 space-y-4">
        {exam.questions.map((question, index) => (
          <li key={question.id} className="card p-4">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-muted">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] leading-relaxed">{question.stem}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
                  {question.source === 'past_paper' && (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">
                      real exam question
                    </span>
                  )}
                  {question.marks !== null && <span>{question.marks} marks</span>}
                  {question.sectionPaths[0] && <span>· {question.sectionPaths[0]}</span>}
                </div>
              </div>
            </div>

            {question.figure && (
              <figure className="mt-3">
                <img
                  src={question.figure.url}
                  alt={question.figure.caption ?? 'Figure this question refers to'}
                  className="max-h-80 w-full rounded-lg border border-line object-contain"
                />
                {question.figure.caption && (
                  <figcaption className="mt-1.5 text-xs text-muted">
                    {question.figure.caption}
                  </figcaption>
                )}
              </figure>
            )}

            {question.options.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {question.options.map((option, optionIndex) => (
                  <li key={optionIndex}>
                    <button
                      className={`w-full rounded-lg border p-2.5 text-left text-sm transition-colors ${
                        answers[question.id]?.optionIndex === optionIndex
                          ? 'border-accent bg-accent/10'
                          : 'border-line hover:border-muted'
                      }`}
                      onClick={() =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: { ...previous[question.id], optionIndex },
                        }))
                      }
                    >
                      <span className="mr-2 font-mono text-xs text-muted">
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                      {option}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <textarea
                className="input mt-3 min-h-28 w-full"
                placeholder="Your answer"
                value={answers[question.id]?.text ?? ''}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [question.id]: { ...previous[question.id], text: event.target.value },
                  }))
                }
              />
            )}
          </li>
        ))}
      </ol>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <span className="text-xs text-muted">
            {answered} of {exam.questions.length} answered · {formatClock(remaining)} left
          </span>
          <button
            className="btn btn-primary"
            disabled={submit.isPending}
            onClick={async () => {
              const blank = exam.questions.length - answered;
              if (blank > 0) {
                const go = await confirm({
                  title: `Submit with ${blank} unanswered?`,
                  message:
                    'Unanswered questions are marked wrong, exactly as they would be in a real ' +
                    'paper. You cannot come back to this one afterwards.',
                  confirmLabel: 'Submit anyway',
                });
                if (!go) return;
              }
              submit.mutate();
            }}
          >
            {submit.isPending ? 'Marking…' : 'Submit paper'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExamResults({ moduleId, result }: { moduleId: string; result: ExamResult }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}/exams`}>
        Mock exams
      </Link>
      <h1 className="text-lg font-semibold">{result.title}</h1>

      <div className="card mt-4 p-5">
        {result.score !== null ? (
          <>
            <p className="text-3xl font-semibold tabular-nums">
              {Math.round(result.score * 100)}%
            </p>
            <p className="mt-1 text-sm text-muted">
              {result.correct} of {result.marked} multiple-choice questions.
            </p>
          </>
        ) : (
          <p className="text-sm">Nothing on this paper could be marked automatically.</p>
        )}

        {result.unmarked > 0 && (
          <p className="mt-3 rounded-md border border-line bg-panel p-3 text-xs leading-relaxed text-muted">
            <strong>{result.unmarked}</strong> written{' '}
            {result.unmarked === 1 ? 'answer is' : 'answers are'} not included in that figure.
            Marking prose needs a mark scheme, and past papers do not come with one — so those
            are yours to mark below. A percentage that quietly counted them as right, or ignored
            them, would read like a result and be a fiction.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
          {result.secondsTaken !== null && (
            <span>Took {Math.round(result.secondsTaken / 60)} min</span>
          )}
          {result.unanswered > 0 && <span>{result.unanswered} left blank</span>}
          {result.confidentlyWrong > 0 && (
            <span className="text-amber-500">
              {result.confidentlyWrong} wrong while certain
            </span>
          )}
        </div>
      </div>

      <ol className="mt-5 space-y-3">
        {result.questions.map((question, index) => (
          <li key={question.questionId} className="card p-4">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-muted">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed">{question.stem}</p>
                <p className="mt-1 text-xs">
                  {question.correct === true && <span className="text-emerald-500">Correct</span>}
                  {question.correct === false && (
                    <span className="text-rose-500">
                      {question.answered ? 'Wrong' : 'Not answered'}
                    </span>
                  )}
                  {question.correct === null && (
                    <span className="text-muted">Mark this one yourself</span>
                  )}
                  {question.confidentlyWrong && (
                    <span className="ml-2 text-amber-500">— and you were sure</span>
                  )}
                </p>
              </div>
            </div>

            {question.options && (
              <ul className="mt-3 space-y-1 text-sm">
                {question.options.map((option, optionIndex) => (
                  <li
                    key={optionIndex}
                    className={
                      optionIndex === question.correctIndex
                        ? 'text-emerald-500'
                        : option.text === question.yourAnswer
                          ? 'text-rose-500'
                          : 'text-muted'
                    }
                  >
                    <span className="mr-2 font-mono text-xs">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    {option.text}
                    {option.whyWrong && optionIndex !== question.correctIndex && (
                      <span className="mt-0.5 block pl-6 text-xs italic">{option.whyWrong}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {question.correct === null && question.yourAnswer && (
              <div className="mt-3 rounded-md border border-line p-3 text-sm">
                <p className="text-xs uppercase tracking-wider text-muted">You wrote</p>
                <p className="mt-1 whitespace-pre-wrap">{question.yourAnswer}</p>
              </div>
            )}

            {question.workedAnswer && (
              <div className="mt-3">
                <p className="text-xs uppercase tracking-wider text-muted">Reasoning</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                  {question.workedAnswer}
                </p>
              </div>
            )}
            {question.source === 'past_paper' && !question.workedAnswer && (
              <p className="mt-3 text-xs italic text-muted">
                This came from a real paper, which prints the question and not the mark scheme.
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
