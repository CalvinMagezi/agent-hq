import * as fs from "fs";
import * as path from "path";

export interface VaultEvent {
    id: string;
    type: string;
    source: string;
    timestamp: string;
    payload: Record<string, any>;
}

export class VaultEventBus {
    private readonly eventsDir: string;

    constructor(vaultPath: string) {
        this.eventsDir = path.join(path.resolve(vaultPath), "_events");
        if (!fs.existsSync(this.eventsDir)) {
            fs.mkdirSync(this.eventsDir, { recursive: true });
        }
    }

    /**
     * Append an event to the daily NDJSON event log.
     */
    public emit(type: string, source: string, payload: Record<string, any> = {}): string {
        const id = `evt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const timestamp = new Date().toISOString();

        const event: VaultEvent = {
            id,
            type,
            source,
            timestamp,
            payload
        };

        const today = timestamp.split("T")[0];
        const logFile = path.join(this.eventsDir, `${today}.log`);

        // NDJSON format (New-line Delimited JSON)
        const line = JSON.stringify(event) + "\n";

        fs.appendFileSync(logFile, line, "utf-8");

        return id;
    }

    /**
     * Read events for a specific day.
     */
    public readEvents(dateStr: string): VaultEvent[] {
        const logFile = path.join(this.eventsDir, `${dateStr}.log`);
        if (!fs.existsSync(logFile)) return [];

        const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(l => l.trim().length > 0);
        const events: VaultEvent[] = [];

        for (const line of lines) {
            try {
                events.push(JSON.parse(line));
            } catch {
                // Skip malformed lines
            }
        }

        return events;
    }
}
