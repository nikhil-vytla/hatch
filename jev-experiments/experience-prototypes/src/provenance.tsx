import { useState, type ReactNode } from "react";
import { ArrowUpRight, ShieldAlert } from "lucide-react";
import { Button } from "./shared";

export function Provenance({ result }: { result: any }) {
  const source = result.provenance;
  if (!source) return null;
  const sources = Array.isArray(source) ? source : [source];
  return (
    <section className="dataset-provenance" aria-label="Dataset provenance">
      <span className="eyebrow">EXTERNAL DATASET</span>
      {sources.map((s: any) => (
        <div className="provenance-source" key={s.name}>
          <div>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.name} <ArrowUpRight size={14} />
            </a>
            <p>
              {s.organization}
              {s.split ? ` · ${s.split} split` : ""}
              {s.license ? ` · ${s.license}` : ""}
            </p>
          </div>
          {s.revision && (
            <code title={s.revision}>revision {s.revision.slice(0, 8)}</code>
          )}
          {s.sampling && <p className="provenance-description">{s.sampling}</p>}
        </div>
      ))}
    </section>
  );
}

export function ContentReview({
  notice,
  children,
}: {
  notice?: any;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!notice || open)
    return (
      <>
        {notice && (
          <div className="content-caption">
            <ShieldAlert size={14} />
            {notice.note}
          </div>
        )}
        {children}
      </>
    );
  return (
    <div className="content-review">
      <ShieldAlert size={24} />
      <h3>Review this case deliberately</h3>
      <p>{notice.note}</p>
      <div className="decision-chips">
        {notice.categories?.map((c: string) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <p className="fine">
        This notice does not remove the case from the score. Any omitted text is
        marked explicitly.
      </p>
      <Button secondary onClick={() => setOpen(true)}>
        Show the prompt and answers
      </Button>
    </div>
  );
}
