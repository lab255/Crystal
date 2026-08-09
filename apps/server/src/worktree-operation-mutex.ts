/**
 * Serializes mutating operations per worktree path. Different worktrees can
 * proceed in parallel; two windows acting on the same one cannot race.
 */
export class WorktreeOperationMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(worktreePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(worktreePath) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const tail = task.then(
      () => {},
      () => {},
    );
    this.tails.set(worktreePath, tail);
    void tail.finally(() => {
      if (this.tails.get(worktreePath) === tail) this.tails.delete(worktreePath);
    });
    return task;
  }
}
