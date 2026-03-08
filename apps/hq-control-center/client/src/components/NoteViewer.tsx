import { useEffect, useState } from "react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
    path: string | null;
}

export const NoteViewer = ({ path }: Props) => {
    const [content, setContent] = useState<string>("");
    const [frontmatter, setFrontmatter] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!path) return;
        setLoading(true);
        fetch(`/api/notes/${encodeURIComponent(path)}`)
            .then(res => res.json())
            .then(data => {
                if (data.note) {
                    setContent(data.note.content);
                    setFrontmatter(data.note.frontmatter);
                } else {
                    setContent("Note not found.");
                    setFrontmatter(null);
                }
            })
            .catch(err => {
                console.error(err);
                setContent("Error loading note");
            })
            .finally(() => setLoading(false));
    }, [path]);

    if (!path) {
        return (
            <div className="hq-panel h-full flex items-center justify-center p-8">
                <span className="text-text-dim text-lg italic tracking-wide">Select a note to view</span>
            </div>
        );
    }

    return (
        <div className="hq-panel h-full flex flex-col overflow-hidden bg-bg-surface">
            <div className="p-4 border-b border-border bg-bg-elevated flex items-center justify-between">
                <h2 className="text-lg font-ui font-semibold text-text-primary tracking-wide truncate pr-4">
                    {path.split('/').pop()?.replace('.md', '')}
                </h2>
                {loading && <span className="status-dot active animate-pulse" />}
            </div>

            <div className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#0a0a0f]">
                <div className="prose prose-invert prose-emerald max-w-3xl mx-auto
            prose-headings:font-ui prose-h1:text-2xl prose-h1:font-bold prose-h1:text-accent-amber
            prose-p:text-text-primary prose-p:leading-relaxed
            prose-a:text-accent-blue prose-a:no-underline hover:prose-a:underline
            prose-code:text-accent-green prose-code:bg-bg-elevated prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
            prose-pre:bg-bg-elevated prose-pre:border prose-pre:border-border">

                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {content}
                    </ReactMarkdown>

                </div>
            </div>
        </div>
    );
};
