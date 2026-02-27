import { Job } from "@repo/vault-client";
import { FbmqCli } from "./fbmqCli";
import { jobCodec } from "./codecs/jobCodec";
import type { ParsedHeaders } from "./types";
import { QueueConfig } from "./types";

export class JobQueue {
    private cli: FbmqCli;

    constructor(config: QueueConfig) {
        this.cli = new FbmqCli(config.queueRoot, config.fbmqBin);
    }

    async init(): Promise<void> {
        await this.cli.init(true); // Jobs queue uses priority
    }

    async enqueue(job: Job): Promise<string> {
        const { body, priority, tags, correlationId, custom } = jobCodec.serialize(job);
        return this.cli.push(body, {
            priority,
            tags: tags ? [tags] : undefined,
            correlationId,
            custom
        });
    }

    async dequeue(): Promise<Job | null> {
        const claimedPath = await this.cli.pop();
        if (!claimedPath) return null;

        const rawBody = await this.cli.cat(claimedPath);
        const headers = await this.cli.inspect(claimedPath);

        // Custom metadata is prepended to the body during push;
        // parse it out and merge into headers before deserializing.
        const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
        headers.custom = { ...headers.custom, ...custom };

        return jobCodec.deserialize(claimedPath, cleanBody, headers);
    }

    async complete(path: string): Promise<void> {
        await this.cli.ack(path);
    }

    async fail(path: string): Promise<void> {
        await this.cli.nack(path);
    }

    async depth(): Promise<number> {
        return this.cli.depth();
    }

    async reap(leaseSecs?: number): Promise<void> {
        await this.cli.reap(leaseSecs);
    }

    async purge(maxAgeSecs?: number): Promise<void> {
        await this.cli.purge(maxAgeSecs);
    }
}
