import Redis from "ioredis";

export interface QueueConfig {
  url: string;
  namespace?: string;
}

export class QueueClient {
  private redis: Redis;
  readonly namespace: string;

  constructor(config: QueueConfig) {
    this.redis = new Redis(config.url);
    this.namespace = config.namespace ?? "harborview";
  }

  key(stream: string): string {
    return this.namespace + ":" + stream;
  }

  async push(stream: string, payload: string): Promise<void> {
    await this.redis.rpush(this.key(stream), payload);
  }

  async pop(stream: string, timeoutSeconds: number): Promise<string | null> {
    const result = await this.redis.blpop(this.key(stream), timeoutSeconds);
    return result ? result[1] : null;
  }

  async depth(stream: string): Promise<number> {
    return this.redis.llen(this.key(stream));
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
