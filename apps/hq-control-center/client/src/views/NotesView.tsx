import { useState } from "react";
import { NoteTree } from "../components/NoteTree";
import { NoteViewer } from "../components/NoteViewer";
import { SearchPanel } from "../components/SearchPanel";

const NotesView = () => {
    const [selectedPath, setSelectedPath] = useState<string | null>(null);

    return (
        <div className="p-4 md:p-6 lg:p-8 h-full bg-[#0a0a0f] overflow-hidden">
            <div className="max-w-[1400px] h-full mx-auto grid grid-cols-1 md:grid-cols-12 gap-6">

                {/* Left Sidebar (Tree + Search) */}
                <div className="md:col-span-3 lg:col-span-3 flex flex-col gap-6 h-[400px] md:h-full">
                    <div className="flex-shrink-0 h-[250px] md:h-[300px]">
                        <SearchPanel onSelect={setSelectedPath} />
                    </div>
                    <div className="flex-1 min-h-0">
                        <NoteTree onSelect={setSelectedPath} selectedPath={selectedPath} />
                    </div>
                </div>

                {/* Right Content Area (Note Viewer) */}
                <div className="md:col-span-9 lg:col-span-9 h-[500px] md:h-full">
                    <NoteViewer path={selectedPath} />
                </div>

            </div>
        </div>
    );
};

export default NotesView;
