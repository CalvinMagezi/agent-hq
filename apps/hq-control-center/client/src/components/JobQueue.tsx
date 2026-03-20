import { useHQStore } from "../store/hqStore";
import { Clock, PlayCircle, CheckCircle2, XCircle } from "lucide-react";

export const JobQueue = () => {
    const jobs = useHQStore(s => s.jobs);

    const getStatusIcon = (status: string) => {
        switch (status) {
            case "running": return <PlayCircle className="w-4 h-4 text-accent-amber" />;
            case "done": return <CheckCircle2 className="w-4 h-4 text-accent-green" />;
            case "failed": return <XCircle className="w-4 h-4 text-accent-red" />;
            default: return <Clock className="w-4 h-4 text-text-dim" />;
        }
    };

    const getStatusClass = (status: string) => {
        switch (status) {
            case "running": return "text-accent-amber border-accent-amber/20 bg-accent-amber/5";
            case "done": return "text-text-dim border-border bg-transparent";
            case "failed": return "text-accent-red border-accent-red/20 bg-accent-red/5";
            default: return "text-text-dim border-border bg-transparent";
        }
    };

    // Helper to format iso date to "2m ago" roughly
    const timeAgo = (isoTime: string) => {
        if (!isoTime) return "";
        const ms = Date.now() - new Date(isoTime).getTime();
        if (isNaN(ms)) return isoTime;

        const minutes = Math.floor(ms / 60000);
        if (minutes < 1) return "just now";
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    return (
        <div className="hq-panel flex flex-col h-full overflow-hidden">
            <div className="p-4 border-b border-border bg-bg-elevated sticky top-0 z-10">
                <h2 className="hq-header">Job Queue</h2>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
                {jobs.length === 0 ? (
                    <div className="p-8 text-center text-text-dim italic">No jobs found</div>
                ) : (
                    <div className="space-y-2">
                        {jobs.map(job => (
                            <div
                                key={job.jobId}
                                className={`p-3 rounded-md border flex items-start gap-3 ${getStatusClass(job.status)}`}
                            >
                                <div className="mt-0.5">{getStatusIcon(job.status)}</div>

                                <div className="flex-1 min-w-0 flex flex-col gap-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono text-xs opacity-70 truncate">{job.jobId}</span>
                                        <span className="text-xs font-mono whitespace-nowrap opacity-60">
                                            {timeAgo(job.updatedAt || job.createdAt)}
                                        </span>
                                    </div>

                                    <div className="text-sm truncate">
                                        {job.instruction || job.type || "Unknown task"}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
