import { AgentGrid } from "../components/AgentGrid";
import { DaemonPanel } from "../components/DaemonPanel";
import { RelayPanel } from "../components/RelayPanel";
import { UsagePanel } from "../components/UsagePanel";
import { JobQueue } from "../components/JobQueue";

const CommandCenter = () => {
    return (
        <div className="p-4 md:p-6 lg:p-8 h-full overflow-y-auto w-[100vw]">
            <div className="max-w-[1400px] mx-auto space-y-6">
                {/* Top: Agent Grid */}
                <section>
                    <AgentGrid />
                </section>

                {/* Middle: 3 Columns Desktop / Stacked Mobile */}
                <section className="grid grid-cols-1 md:grid-cols-12 gap-6 h-[400px]">
                    {/* Left: Daemon & Relay stacked */}
                    <div className="md:col-span-4 flex flex-col gap-6 h-full">
                        <div className="flex-1"><DaemonPanel /></div>
                        <div className="h-48 flex-shrink-0"><RelayPanel /></div>
                    </div>

                    {/* Right/Middle: Jobs Queue */}
                    <div className="md:col-span-5 h-[400px] md:h-full">
                        <JobQueue />
                    </div>

                    <div className="md:col-span-3 h-48 md:h-auto md:flex md:flex-col">
                        <UsagePanel />
                    </div>
                </section>
            </div>
        </div>
    );
};

export default CommandCenter;
