import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ConceptMap, type MapNode } from '../lib/api';

/**
 * The concept map — §10.
 *
 * WHAT AN EDGE MEANS, AND WHY THAT MATTERS
 *
 * An edge is not "these are related". It is "ownership assignment measured
 * these two statements as saying close to the same thing", which is narrower
 * and is the only claim the data supports. Drawing it as a general knowledge
 * graph would be a prettier picture and a false one.
 *
 * Read that way it answers two real questions. A concept with several edges is
 * one the module keeps returning to — important, and a natural bridge
 * question. A section with no edges at all is either genuinely self-contained
 * or has drifted in vocabulary from the rest of the module, and only you can
 * say which.
 *
 * THE LAYOUT IS DETERMINISTIC ON PURPOSE
 *
 * Sections take fixed arcs of a circle and concepts sit evenly along them, so
 * the same module draws the same way every time. A force-directed layout looks
 * more impressive and settles somewhere different on each load, which makes it
 * useless for the thing a map is actually for: recognising the shape of your
 * own module and noticing when it changes.
 */
export function ConceptMapPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const [hovered, setHovered] = useState<string | null>(null);
  const [showWithinSection, setShowWithinSection] = useState(false);

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['concept-map', moduleId],
    queryFn: () => api.getConceptMap(moduleId!),
    enabled: Boolean(moduleId),
  });

  const layout = useMemo(() => (data ? place(data) : null), [data]);

  if (isLoading) return <div className="p-6"><div className="skeleton h-96" /></div>;

  const edges = (data?.edges ?? []).filter(
    (edge) => showWithinSection || edge.crossSection,
  );

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}`}>
            {module?.title ?? 'Module'}
          </Link>
          <h1 className="text-lg font-semibold">Concept map</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            A line means two concepts were measured as saying close to the same thing — not that
            they are loosely related. So a concept with several lines is one the module keeps
            coming back to, and a section with none has either kept to itself or drifted in
            vocabulary from the rest.
          </p>
        </div>
      </div>

      {!data || data.nodes.length === 0 ? (
        <div className="card mt-6 p-6 text-center text-sm text-muted">
          No concepts in this module yet. Extract them from a section’s Concepts tab — the map is
          drawn from the concept list and the matches between them.
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={showWithinSection}
                onChange={(event) => setShowWithinSection(event.target.checked)}
              />
              Show links inside a section too
            </label>
            <span className="text-xs text-muted">
              {data.nodes.length} concepts · {edges.length} link{edges.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="card mt-3 overflow-x-auto p-2">
            <svg viewBox="0 0 620 620" className="mx-auto block h-[560px] w-full max-w-[620px]">
              {/* Lines first, so nodes sit on top of them. */}
              {layout &&
                edges.map((edge, index) => {
                  const from = layout.positions.get(edge.from);
                  const to = layout.positions.get(edge.to);
                  if (!from || !to) return null;
                  const active = hovered === edge.from || hovered === edge.to;
                  return (
                    <line
                      key={index}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="currentColor"
                      className={active ? 'text-accent' : 'text-muted'}
                      strokeOpacity={active ? 0.9 : hovered ? 0.06 : 0.22}
                      strokeWidth={active ? 1.6 : 0.8}
                    />
                  );
                })}

              {layout &&
                data.nodes.map((node) => {
                  const at = layout.positions.get(node.id);
                  if (!at) return null;
                  const active = hovered === node.id;
                  // Size carries how connected it is, which is the thing the
                  // map is for. Colour carries the section.
                  const radius = 3 + Math.min(6, node.degree * 1.4) + (active ? 2 : 0);
                  return (
                    <circle
                      key={node.id}
                      cx={at.x}
                      cy={at.y}
                      r={radius}
                      fill={colourFor(node.sectionIndex)}
                      fillOpacity={node.examinable ? 1 : 0.45}
                      stroke={active ? 'currentColor' : 'none'}
                      className="cursor-pointer text-fg"
                      strokeWidth={1.5}
                      onMouseEnter={() => setHovered(node.id)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <title>{node.statement}</title>
                    </circle>
                  );
                })}

              {/* Section labels sit outside the ring. */}
              {layout?.labels.map((label) => (
                <text
                  key={label.sectionId}
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className="fill-current text-[9px] text-muted"
                >
                  {label.text}
                </text>
              ))}
            </svg>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            {data.sections.map((section) => (
              <span key={section.id} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: colourFor(section.index) }}
                />
                <span className="text-muted">
                  {section.path} ({section.concepts})
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            A hollow-looking dot is a concept no past paper has asked about. Bigger dots have more
            links.
          </p>

          {data.isolatedSections.length > 0 && (
            <div className="card mt-4 p-4">
              <h2 className="text-sm font-semibold">Sections that connect to nothing</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Two things cause this and they call for opposite responses: the section really is
                self-contained, or its concepts are worded differently enough from the rest of the
                module that nothing matched. The second is worth fixing, because bridge questions
                are sampled across sections and there is nothing here to bridge to.
              </p>
              <ul className="mt-2 text-sm">
                {data.isolatedSections.map((path) => (
                  <li key={path} className="text-muted">
                    · {path}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="mt-6 text-sm font-semibold uppercase tracking-wider text-muted">
            Most connected
          </h2>
          <ul className="mt-2 space-y-1.5">
            {[...data.nodes]
              .filter((node) => node.degree > 0)
              .sort((a, b) => b.degree - a.degree)
              .slice(0, 8)
              .map((node) => (
                <li key={node.id} className="card p-3 text-sm">
                  <Link
                    className="hover:underline"
                    to={`/modules/${moduleId}/sections/${node.sectionId}`}
                  >
                    {node.statement}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {node.sectionPath} · {node.degree} link{node.degree === 1 ? '' : 's'}
                    {node.mastery !== null && ` · ${Math.round(node.mastery * 100)}% mastered`}
                  </p>
                </li>
              ))}
            {data.nodes.every((node) => node.degree === 0) && (
              <li className="card p-4 text-sm text-muted">
                Nothing is linked yet. Links are found when concept ownership is assigned across
                the module — run extraction on more than one section, and it happens at the end.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Concepts on a ring, grouped by section.
 *
 * Each section gets an arc proportional to how many concepts it has, and its
 * concepts sit evenly along it. The result is the same every time the same
 * module is drawn — which a force-directed layout is not, and which is what
 * makes it possible to recognise your own module and notice when it changes.
 */
function place(map: ConceptMap) {
  const centre = 310;
  const radius = 225;
  const positions = new Map<string, { x: number; y: number }>();
  const labels: Array<{
    sectionId: string;
    x: number;
    y: number;
    text: string;
    anchor: 'start' | 'end' | 'middle';
  }> = [];

  const bySection = new Map<string, MapNode[]>();
  for (const node of map.nodes) {
    const list = bySection.get(node.sectionId) ?? [];
    list.push(node);
    bySection.set(node.sectionId, list);
  }

  const total = map.nodes.length;
  // A small gap between sections, so the groups read as groups.
  const gap = Math.min(0.12, (Math.PI * 2) / Math.max(1, bySection.size) / 4);
  let angle = -Math.PI / 2;

  for (const section of map.sections) {
    const concepts = bySection.get(section.id) ?? [];
    if (concepts.length === 0) continue;

    const span = (Math.PI * 2 * concepts.length) / total - gap;
    concepts.forEach((node, index) => {
      const at = angle + (concepts.length === 1 ? span / 2 : (span * index) / (concepts.length - 1));
      positions.set(node.id, {
        x: centre + radius * Math.cos(at),
        y: centre + radius * Math.sin(at),
      });
    });

    const mid = angle + span / 2;
    const labelRadius = radius + 30;
    const x = centre + labelRadius * Math.cos(mid);
    labels.push({
      sectionId: section.id,
      x,
      y: centre + labelRadius * Math.sin(mid),
      text: section.path.length > 26 ? `${section.path.slice(0, 25)}…` : section.path,
      anchor: Math.abs(x - centre) < 40 ? 'middle' : x > centre ? 'start' : 'end',
    });

    angle += span + gap;
  }

  return { positions, labels };
}

/**
 * Colours by section index. Fixed hues rather than random ones, so a section
 * keeps its colour between the map and the legend and between visits.
 */
function colourFor(index: number): string {
  const hues = [158, 210, 32, 280, 0, 190, 55, 320];
  return `hsl(${hues[index % hues.length]} 55% 48%)`;
}
