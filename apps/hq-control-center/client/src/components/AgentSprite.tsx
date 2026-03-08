import { motion } from "framer-motion";
import { ReactNode } from "react";

export type SpriteStatus = "idle" | "active" | "error";

interface Props {
    id: string;
    name: string;
    status: SpriteStatus;
    icon: ReactNode;
}

export const AgentSprite = ({ name, status, icon }: Props) => {
    // Determine ring animation params based on status
    let ringAnim = {};
    let iconAnim = {};
    let color = "var(--color-text-dim)";

    if (status === "active") {
        ringAnim = {
            scale: [1, 1.05, 1],
            opacity: [0.4, 0.8, 0.4],
            rotate: [0, 180, 360],
            filter: ["drop-shadow(0 0 4px rgba(0,255,136,0.2))", "drop-shadow(0 0 12px rgba(0,255,136,0.6))", "drop-shadow(0 0 4px rgba(0,255,136,0.2))"]
        };
        iconAnim = {
            y: [0, -4, 0]
        };
        color = "var(--color-accent-green)";
    } else if (status === "error") {
        ringAnim = {
            x: [0, -2, 2, -2, 2, 0]
        };
        color = "var(--color-accent-red)";
    } else {
        ringAnim = {
            scale: [1, 1.02, 1],
            opacity: [0.2, 0.4, 0.2]
        };
        color = "var(--color-text-dim)";
    }

    return (
        <div className="flex flex-col items-center gap-2 group">
            <div className="relative w-16 h-16 flex items-center justify-center">
                {/* Outer Ring */}
                <motion.div
                    className="absolute inset-0 rounded-full border-2 border-dashed"
                    style={{ borderColor: color }}
                    animate={ringAnim}
                    transition={{
                        duration: status === "active" ? 2 : (status === "error" ? 0.5 : 4),
                        repeat: status === "error" ? 0 : Infinity,
                        ease: "easeInOut"
                    }}
                />

                {/* Inner Icon */}
                <motion.div
                    className="z-10 text-2xl"
                    style={{ color }}
                    animate={iconAnim}
                    transition={{
                        duration: 0.8,
                        repeat: Infinity,
                        ease: "easeInOut"
                    }}
                >
                    {icon}
                </motion.div>

                {/* Status Dot */}
                <div className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-[#0a0a0f] 
          ${status === "active" ? "bg-accent-green shadow-[0_0_8px_inset_#00ff88]" :
                        status === "error" ? "bg-accent-red" : "bg-text-dim"}`}
                />
            </div>
            <span className="text-xs font-mono font-medium tracking-wide text-text-primary text-center leading-tight">
                {name}
            </span>
        </div>
    );
};
