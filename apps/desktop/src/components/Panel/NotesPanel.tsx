import Markdown from 'react-markdown';

interface Props {
  notes: string | null;
}

export function NotesPanel({ notes }: Props): React.ReactElement {
  return (
    <div className="px-4 py-3">
      <h3 className="text-xs uppercase tracking-wide text-text-muted mb-2">Notes</h3>
      {notes ? (
        <div
          className="prose prose-invert prose-sm max-w-none
                     prose-headings:text-text-primary prose-p:text-text-primary
                     prose-li:text-text-primary prose-strong:text-text-primary"
        >
          <Markdown>{notes}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-text-muted">
          A summary is generated automatically when you stop recording.
        </p>
      )}
    </div>
  );
}
