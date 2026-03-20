import { useHQStore } from "../store/hqStore";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export const DaemonPanel = () => {
    const daemonTasks = useHQStore(s => s.daemonTasks);

    return (
        <div className="hq-panel p-4 flex flex-col h-full">
            <h2 className="hq-header mb-4">Daemon Tasks</h2>
            <div className="flex-1 overflow-y-auto space-y-1">
                {daemonTasks.length === 0 ? (
                    <div className="text-text-dim text-sm italic py-4 text-center">No daemon data</div>
                ) : (
                    daemonTasks.map((task, i) => {
                        const hasErrors = parseInt(task.errors) > 0;
                        return (
                            <div
                                key={i}
                                className="flex items-center justify-between py-2 border-b border-border border-opacity-30 last:border-0"
                            >
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">{task.task}</span>
                                    {hasErrors && <span className="text-xs text-accent-red mt-0.5">{task.lastError || "Error occurred"}</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-mono text-text-dim">{task.lastRun}</span>
                                    {hasErrors ? (
                                        <XCircle className="w-4 h-4 text-accent-red" />
                                    ) : (
                                        <CheckCircle2 className="w-4 h-4 text-accent-green" />
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
