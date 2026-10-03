/**
 * The report format, for benchmark and comparison pages (after LMArena's interval tables and The
 * Pudding's "method behind a link"): an abstract, then numbered sections, data and a citation. A
 * benchmark whose scene already shows its method and results keeps the scene as its results
 * section; a page that is only a toy gets its tables here and the toy as a companion.
 */
import type { ReactNode } from "react";
import "./formats.css";

export type ReportSection = { id: string; title: string; content: ReactNode };

export function Report({
  abstract,
  sections,
  data,
  cite,
}: {
  abstract: ReactNode;
  sections: ReportSection[];
  data: ReactNode;
  cite: ReactNode;
}) {
  const all = [...sections, { id: "data", title: "Data", content: data }];

  return (
    <article className="fmt-report">
      <section className="fmt-abstract" aria-labelledby="report-abstract">
        <h2 id="report-abstract">Abstract</h2>
        {abstract}
        <ol className="fmt-contents" aria-label="Contents">
          {all.map((s, i) => (
            <li key={s.id}>
              <a href={`#report-${s.id}`} onClick={(e) => jump(e, s.id)}>
                {i + 1}. {s.title}
              </a>
            </li>
          ))}
        </ol>
      </section>
      {all.map((s, i) => (
        <section key={s.id} id={`report-${s.id}`} aria-labelledby={`report-${s.id}-title`} className={s.id === "results" ? "fmt-results" : undefined}>
          <h2 id={`report-${s.id}-title`}>
            {i + 1}. {s.title}
          </h2>
          {s.content}
        </section>
      ))}
      {cite}
    </article>
  );
}

/** The site routes by hash, so contents links scroll instead of changing the hash. */
function jump(e: { preventDefault: () => void }, id: string) {
  e.preventDefault();
  document.getElementById(`report-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
