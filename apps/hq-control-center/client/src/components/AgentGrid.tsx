import { useHQStore } from "../store/hqStore";
import { AgentSprite, SpriteStatus } from "./AgentSprite";
import {
    Cpu, Webhook, Bot, Sparkles, Code2,
    SearchCode, Network, CalendarClock, FileEdit,
    Briefcase, Link2, Database, Share2
} from "lucide-react";

const ROSTER = [
    { id: "hq-worker", name: "HQ Brain", icon: <Cpu /> },
    { id: "daemon", name: "Daemon", icon: <Webhook /> },
    { id: "relay-claude", name: "Claude Relay", icon: <Bot /> },
    { id: "relay-gemini", name: "Gemini Relay", icon: <Sparkles /> },
    { id: "relay-opencode", name: "OpenCode Relay", icon: <Code2 /> },
    { id: "worker:gap-detector", name: "Gap Detector", icon: <SearchCode /> },
    { id: "worker:idea-connector", name: "Idea Connector", icon: <Network /> },
    { id: "worker:project-nudger", name: "Project Nudger", icon: <CalendarClock /> },
    { id: "worker:note-enricher", name: "Note Enricher", icon: <FileEdit /> },
    { id: "worker:daily-preparer", name: "Daily Preparer", icon: <Briefcase /> },
    { id: "worker:orphan-rescuer", name: "Orphan Rescuer", icon: <Link2 /> },
    { id: "cron:embeddings", name: "Embeddings", icon: <Database /> },
    { id: "cron:note-linking", name: "Note Linking", icon: <Share2 /> }
];

export const AgentGrid = () => {
    const agents = useHQStore(s => s.agents);
    const daemonTasks = useHQStore(s => s.daemonTasks);
    const jobs = useHQStore(s => s.jobs);

    // Logic to determine status
    const getStatus = (id: string): SpriteStatus => {
        // 1. Daemon is always active
        if (id === "daemon") return daemonTasks.some(t => parseInt(t.errors) > 0) ? "error" : "active";

        // 2. Relays reading from relay health
        if (id.startsWith("relay-")) {
            const relayName = id.replace("relay-", "");
            // Map relayName to the actual relay ID if known, or match by name
            const relay = agents.find(a => a.relayId?.toLowerCase().includes(relayName) || a.id?.toLowerCase().includes(relayName));
            if (!relay) return "error"; // Offline or not found
            return relay.status === "healthy" ? "active" : "error";
        }

        // 3. Workers
        if (id === "hq-worker" || id.startsWith("worker:")) {
            // Find if they have a running job
            const isRunningJob = jobs.some(j => j.status === "running" && (j.agentId === id || j.workerId === id));
            if (isRunningJob) return "active";

            const session = agents.find(a => a.id === id);
            if (session && session.status === "error") return "error";
            return "idle";
        }

        // 4. Cron tasks (from DAEMON-STATUS)
        if (id.startsWith("cron:")) {
            const parts = id.split(":");
            const task = daemonTasks.find(t => t.task === parts[1]);
            if (!task) return "idle";
            if (parseInt(task.errors) > 0) return "error";
            // Determine if recently run (e.g. less than 5 minutes ago)
            // This requires date parsing, simplified here to "idle" unless error
            return "idle";
        }

        return "idle";
    };

    return (
        <div className="hq-panel p-6">
            <h2 className="hq-header mb-6">Agent Roster</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-y-8 gap-x-4">
                {ROSTER.map(agent => (
                    <AgentSprite
                        key={agent.id}
                        id={agent.id}
                        name={agent.name}
                        icon={agent.icon}
                        status={getStatus(agent.id)}
                    />
                ))}
            </div>
        </div>
    );
};
