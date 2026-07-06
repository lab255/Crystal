import { QueueClient, JobConsumer } from "@harborview/queue";
import { loadWorkerConfig } from "./config";
import { processJob } from "./dispatcher";
import type { Deps } from "./dispatcher";
import type { Mailer } from "./processors/email";
import type { PaymentGateway } from "./processors/payment";

const mailer: Mailer = {
  async send(to, subject, body) {
    console.log("email -> " + to + " | " + subject + "\n" + body);
  },
};

const gateway: PaymentGateway = {
  async charge(_amountCents, _currency, reference) {
    return { id: "ch_" + reference, status: "succeeded" };
  },
};

export async function start(): Promise<void> {
  const config = loadWorkerConfig();
  const client = new QueueClient({ url: config.redisUrl });
  const consumer = new JobConsumer(client);
  const deps: Deps = { mailer, gateway };
  console.log("harborview worker running with concurrency " + config.concurrency);
  await consumer.run((job) => processJob(job, deps));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
