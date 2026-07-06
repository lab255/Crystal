import { QueueClient } from "./client";
import { Job, JOB_STREAM } from "./jobs";

export type JobHandler = (job: Job) => Promise<void>;

export class JobConsumer {
  private running = false;

  constructor(private client: QueueClient) {}

  async run(handler: JobHandler): Promise<void> {
    this.running = true;
    while (this.running) {
      const raw = await this.client.pop(JOB_STREAM, 5);
      if (!raw) continue;
      const job = JSON.parse(raw) as Job;
      await handler(job);
    }
  }

  stop(): void {
    this.running = false;
  }
}
