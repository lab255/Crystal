import { QueueClient } from "./client";
import { Job, JOB_STREAM } from "./jobs";
import { retryWithBackoff } from "./util";

export class JobPublisher {
  constructor(private client: QueueClient) {}

  async publish(job: Job): Promise<void> {
    const payload = JSON.stringify(job);
    await retryWithBackoff(() => this.client.push(JOB_STREAM, payload), 3);
  }

  async publishAll(jobs: Job[]): Promise<void> {
    for (const job of jobs) {
      await this.publish(job);
    }
  }
}
