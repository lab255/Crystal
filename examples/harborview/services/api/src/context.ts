import {
  createDatabase,
  BookingsRepository,
  SailingsRepository,
  VesselsRepository,
} from "@harborview/db";
import { QueueClient, JobPublisher } from "@harborview/queue";
import type { ApiConfig } from "./config";

export interface AppContext {
  bookings: BookingsRepository;
  sailings: SailingsRepository;
  vessels: VesselsRepository;
  publisher: JobPublisher;
}

export function createContext(config: ApiConfig): AppContext {
  const db = createDatabase(config.databaseUrl);
  const queue = new QueueClient({ url: config.redisUrl });
  return {
    bookings: new BookingsRepository(db),
    sailings: new SailingsRepository(db),
    vessels: new VesselsRepository(db),
    publisher: new JobPublisher(queue),
  };
}
