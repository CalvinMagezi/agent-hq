import { DelegatedTask, HarnessType } from "@repo/vault-client";
import { FbmqCli } from "./fbmqCli";
import { delegationCodec } from "./codecs/delegationCodec";
import { QueueConfig } from "./types";

export class DelegationQueue {
    private mainClis: Map<string, FbmqCli> = new Map();
    private stagedCli: FbmqCli;
    private config: QueueConfig;

    constructor(config: QueueConfig, stagedQueueRoot: string) {
        this.config = config;
        this.stagedCli = new FbmqCli(stagedQueueRoot, config.fbmqBin);
    }

    private async getHarnessCli(harnessType: string): Promise<FbmqCli> {
        const type = (harnessType && harnessType !== "any") ? harnessType : "any";
        if (!this.mainClis.has(type)) {
            const root = type === "any" ? this.config.queueRoot : `${this.config.queueRoot}-${type}`;
            const cli = new FbmqCli(root, this.config.fbmqBin);
            await cli.init(true);
            this.mainClis.set(type, cli);
        }
        return this.mainClis.get(type)!;
    }

    private getCliForPath(path: string): FbmqCli | null {
        const clis = Array.from(this.mainClis.entries()).sort((a, b) => b[0].length - a[0].length);
        for (const [type, cli] of clis) {
            const expectedRoot = type === "any" ? this.config.queueRoot : `${this.config.queueRoot}-${type}`;
            if (path.includes(expectedRoot)) {
                return cli;
            }
        }
        return this.mainClis.get("any") || null;
    }

    async init(): Promise<void> {
        await this.stagedCli.init(false); // staged uses no priority (FIFO)
        await this.getHarnessCli("any");
    }

    async enqueue(task: DelegatedTask): Promise<string> {
        const { body, priority, correlationId, custom, ttl } = delegationCodec.serialize(task);

        const isStaged = task.dependsOn && task.dependsOn.length > 0;
        const cli = isStaged ? this.stagedCli : await this.getHarnessCli(task.targetHarnessType);

        return cli.push(body, {
            priority: isStaged ? undefined : priority,
            correlationId,
            custom,
            ttl
        });
    }

    async dequeue(targetHarnessType?: HarnessType): Promise<DelegatedTask | null> {
        const typesToTry = [];
        if (targetHarnessType && targetHarnessType !== "any") {
            typesToTry.push(targetHarnessType);
        }
        typesToTry.push("any");

        for (const type of typesToTry) {
            const cli = await this.getHarnessCli(type);
            const claimedPath = await cli.pop();

            if (claimedPath) {
                const rawBody = await cli.cat(claimedPath);
                const headers = await cli.inspect(claimedPath);
                const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
                headers.custom = { ...headers.custom, ...custom };
                const task = delegationCodec.deserialize(claimedPath, cleanBody, headers);

                return task;
            }
        }
        return null;
    }

    async inspectPath(path: string) {
        const cli = this.getCliForPath(path);
        if (!cli) throw new Error("No FbmqCli found for path");
        return cli.inspect(path);
    }

    async catPath(path: string) {
        const cli = this.getCliForPath(path);
        if (!cli) throw new Error("No FbmqCli found for path");
        return cli.cat(path);
    }

    async complete(path: string): Promise<void> {
        const cli = this.getCliForPath(path);
        if (cli) await cli.ack(path);
    }

    async fail(path: string): Promise<void> {
        const cli = this.getCliForPath(path);
        if (cli) await cli.nack(path);
    }

    async promoteReady(completedTaskIds: Set<string>): Promise<void> {
        // In actual implementation, we'd need to pop from staged and check if deps are met.
        // For now, this requires popping everything from staged, checking deps, and either
        // pushing to main or nacking back to staged.
        // A more efficient way is to just let fbmq do its thing, but staged doesn't have a 
        // built-in "peek all". We can just pop until empty.
        const toRequeue = [];
        const toPromote = [];

        while (true) {
            const claimedPath = await this.stagedCli.pop();
            if (!claimedPath) break;

            const rawBody = await this.stagedCli.cat(claimedPath);
            const headers = await this.stagedCli.inspect(claimedPath);
            const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
            headers.custom = { ...headers.custom, ...custom };
            const task = delegationCodec.deserialize(claimedPath, cleanBody, headers);

            const ready = task.dependsOn.every(dep => completedTaskIds.has(dep));
            if (ready) {
                task.dependsOn = []; // clear deps
                toPromote.push(task);
                await this.stagedCli.ack(claimedPath);
            } else {
                toRequeue.push(claimedPath);
            }
        }

        // Nack the ones not ready
        for (const path of toRequeue) {
            await this.stagedCli.nack(path);
        }

        // Push ready ones to main
        for (const task of toPromote) {
            await this.enqueue(task); // this will go to main because dependsOn is empty
        }
    }

    async depth(): Promise<number> {
        let total = 0;
        for (const cli of this.mainClis.values()) {
            total += await cli.depth();
        }
        return total;
    }

    async stagedDepth(): Promise<number> {
        return this.stagedCli.depth();
    }

    async reap(leaseSecs?: number): Promise<void> {
        for (const cli of this.mainClis.values()) {
            await cli.reap(leaseSecs);
        }
    }

    async purge(maxAgeSecs?: number): Promise<void> {
        for (const cli of this.mainClis.values()) {
            await cli.purge(maxAgeSecs);
        }
        await this.stagedCli.purge(maxAgeSecs);
    }
}
