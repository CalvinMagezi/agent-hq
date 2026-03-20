import { useHQStore } from "../store/hqStore";
import { JobQueue } from "../components/JobQueue";

const JobsView = () => {
    return (
        <div className="p-4 md:p-6 lg:p-8 h-full bg-[#0a0a0f]">
            <div className="max-w-[1000px] mx-auto h-full flex flex-col">
                <h1 className="text-xl font-mono mb-4 text-accent-blue">Full Job History</h1>
                <div className="flex-1 min-h-0 bg-[#111118]">
                    <JobQueue />
                </div>
            </div>
        </div>
    );
};

export default JobsView;
