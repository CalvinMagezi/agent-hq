import { useHQStore } from "../store/hqStore";

export const UsagePanel = () => {
    const usage = useHQStore(s => s.usage);
    const percentage = Math.min((usage.month / usage.budget) * 100, 100);

    // Progress bar rendering helper
    const renderBar = () => {
        // 20 blocks
        const totalBlocks = 20;
        const filledBlocks = Math.round((percentage / 100) * totalBlocks);

        let bar = "[";
        for (let i = 0; i < totalBlocks; i++) {
            bar += i < filledBlocks ? "█" : "░";
        }
        bar += "]";
        return bar;
    };

    return (
        <div className="hq-panel p-4 flex flex-col h-full">
            <h2 className="hq-header mb-4">Usage & Budget</h2>
            <div className="flex flex-col gap-3 font-mono text-sm tracking-wide">
                <div className="flex items-center justify-between">
                    <span className="text-text-dim">Today:</span>
                    <span className="text-accent-green">${usage.today.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-text-dim">Month:</span>
                    <span>${usage.month.toFixed(2)} / ${usage.budget.toFixed(2)}</span>
                </div>
                <div className="mt-2 text-accent-blue flex items-center justify-between">
                    <span>{renderBar()}</span>
                    <span className="ml-2">{percentage.toFixed(1)}%</span>
                </div>
            </div>
        </div>
    );
};
