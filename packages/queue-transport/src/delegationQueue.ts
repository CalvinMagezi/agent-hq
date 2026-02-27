import { DelegatedTask, HarnessType } from "@repo/vault-client";
import { FbmqCli } from "./fbmqCli";
import { delegationCodec } from "./codecs/delegationCodec";
import { QueueConfig } from "./types";

export class DelegationQueue {
    private mainCli: FbmqCli;
    private stagedCli: FbmqCli;

    constructor(config: QueueConfig, stagedQueueRoot: string) {
        this.mainCli = new FbmqCli(config.queueRoot, config.fbmqBin);
        this.stagedCli = new FbmqCli(stagedQueueRoot, config.fbmqBin);
    }

    async init(): Promise<void> {
        await this.mainCli.init(true); // main uses priority
        await this.stagedCli.init(false); // staged uses no priority (FIFO)
    }

    async enqueue(task: DelegatedTask): Promise<string> {
        const { body, priority, correlationId, custom, ttl } = delegationCodec.serialize(task);

        const isStaged = task.dependsOn && task.dependsOn.length > 0;
        const cli = isStaged ? this.stagedCli : this.mainCli;

        return cli.push(body, {
            priority: isStaged ? undefined : priority,
            correlationId,
            custom,
            ttl
        });
    }

    async dequeue(targetHarnessType?: HarnessType): Promise<DelegatedTask | null> {
        // We may need to pop and nack until we find a matching harness type.
        // However, to prevent infinite loops, we should limit pop attempts.
        // For simplicity, pop once, if it doesn't match, nack and return null.
        // A better approach is multiple queues or tag filtering if fbmq supports it.
        // But `fbmq pop` doesn't filter by tag natively in the MVP.
        // We just pop and nack.
        const claimedPath = await this.mainCli.pop();
        if (!claimedPath) return null;

        const rawBody = await this.mainCli.cat(claimedPath);
        const headers = await this.mainCli.inspect(claimedPath);
        const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
        headers.custom = { ...headers.custom, ...custom };
        const task = delegationCodec.deserialize(claimedPath, cleanBody, headers);

        if (targetHarnessType && targetHarnessType !== "any" && task.targetHarnessType !== targetHarnessType && task.targetHarnessType !== "any") {
            await this.mainCli.nack(claimedPath);
            return null;
        }

        return task;
    }

    async complete(path: string): Promise<void> {
        await this.mainCli.ack(path);
    }

    async fail(path: string): Promise<void> {
        await this.mainCli.nack(path);
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
        return this.mainCli.depth();
    }

    async stagedDepth(): Promise<number> {
        return this.stagedCli.depth();
    }

    async reap(leaseSecs?: number): Promise<void> {
        await this.mainCli.reap(leaseSecs);
    }

    async purge(maxAgeSecs?: number): Promise<void> {
        await this.mainCli.purge(maxAgeSecs);
        await this.stagedCli.purge(maxAgeSecs);
    }
}
