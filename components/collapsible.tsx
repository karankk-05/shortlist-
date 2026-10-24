import type { ReactNode } from 'react';

/** Keep content mounted so nested height changes and rapid reversals animate naturally. */
export default function Collapsible({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return <div id={id} className="collapse-region" data-open={open} aria-hidden={!open} inert={!open}>
    <div className="collapse-content">{children}</div>
  </div>;
}
