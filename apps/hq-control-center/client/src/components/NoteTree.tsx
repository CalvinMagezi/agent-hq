import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, FileText } from "lucide-react";

interface NoteTreeProps {
    onSelect: (path: string) => void;
    selectedPath: string | null;
}

export const NoteTree = ({ onSelect, selectedPath }: NoteTreeProps) => {
    const [tree, setTree] = useState<any>(null);

    useEffect(() => {
        fetch("/api/notes").then(res => res.json()).then(data => {
            if (data.tree) setTree(data.tree);
        }).catch(console.error);
    }, []);

    if (!tree) return <div className="p-4 text-text-dim text-sm italic">Loading tree...</div>;

    return (
        <div className="hq-panel h-full overflow-y-auto">
            <div className="p-3 border-b border-border sticky top-0 bg-bg-surface z-10">
                <h2 className="font-mono text-sm tracking-widest text-accent-amber uppercase">Vault</h2>
            </div>
            <div className="p-2 space-y-1">
                <TreeNode node={tree} depth={0} onSelect={onSelect} selectedPath={selectedPath} />
            </div>
        </div>
    );
};

const TreeNode = ({ node, depth, onSelect, selectedPath }: { node: any, depth: number, onSelect: any, selectedPath: string | null }) => {
    const [open, setOpen] = useState(depth === 0);

    if (node.type === "file") {
        const isSelected = selectedPath === node.path;
        return (
            <div
                className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-colors
          ${isSelected ? "bg-accent-amber/20 text-accent-amber" : "text-text-primary hover:bg-border/30"}`}
                style={{ paddingLeft: `${depth * 12 + 12}px` }}
                onClick={() => onSelect(node.path)}
            >
                <FileText className="w-3.5 h-3.5 opacity-60" />
                <span className="text-sm truncate">{node.name.replace(".md", "")}</span>
            </div>
        );
    }

    return (
        <>
            <div
                className="flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-text-primary hover:bg-border/30 transition-colors"
                style={{ paddingLeft: `${depth * 12}px` }}
                onClick={() => setOpen(!open)}
            >
                <span className="opacity-50 text-text-dim">
                    {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </span>
                <span className="text-sm font-medium tracking-wide truncate">{node.name}</span>
            </div>
            {open && node.children && (
                <div className="flex flex-col gap-0.5">
                    {node.children.map((child: any, i: number) => (
                        <TreeNode key={i} node={child} depth={depth + 1} onSelect={onSelect} selectedPath={selectedPath} />
                    ))}
                </div>
            )}
        </>
    );
};
