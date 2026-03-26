export class MessageQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue(
    threadId: string,
    work: () => Promise<void>,
    onError?: (err: Error) => void
  ): Promise<void> {
    const existing = this.queues.get(threadId) ?? Promise.resolve();
    const next = existing.then(() => work()).catch((err) => {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    });
    this.queues.set(threadId, next);
    return next;
  }
}
