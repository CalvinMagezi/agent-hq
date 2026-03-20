import { useState } from "react";
import { Search } from "lucide-react";

interface Props {
    onSelect: (path: string) => void;
}

export const SearchPanel = ({ onSelect }: Props) => {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) return;

        setLoading(true);
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            setResults(data.results || []);
        } catch (err) {
            console.error("Search failed", err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="hq-panel h-full flex flex-col">
            <div className="p-3 border-b border-border bg-bg-surface sticky top-0">
                <form onSubmit={handleSearch} className="relative">
                    <input
                        type="text"
                        placeholder="Search vault..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="w-full bg-[#0a0a0f] border border-border rounded px-8 py-1.5 text-sm font-ui text-text-primary focus:outline-none focus:border-accent-blue transition-colors"
                    />
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-dim" />
                    {loading && <div className="absolute right-3 top-1/2 -translate-y-1/2 status-dot active animate-pulse" />}
                </form>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1 p-2">
                {results.length === 0 && query && !loading ? (
                    <div className="text-center text-text-dim text-sm italic p-4">No results found</div>
                ) : (
                    results.map((res, i) => (
                        <div
                            key={i}
                            className="p-2 rounded hover:bg-border/30 cursor-pointer transition-colors"
                            onClick={() => onSelect(res.noteId || res._filePath)}
                        >
                            <div className="text-sm font-medium text-accent-blue truncate">{res.title}</div>
                            <div className="text-xs text-text-dim truncate mt-0.5">{res.notebook}</div>
                            {res.snippet && (
                                <div className="text-xs text-text-primary/70 line-clamp-2 mt-1 leading-snug">
                                    {res.snippet}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
