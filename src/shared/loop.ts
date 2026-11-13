/** Tiny restartable polling loop; `stop()` resolves after the in-flight iteration finishes. */
export class Loop {
  private running = false;
  private done: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly body: (isStopping: () => boolean) => Promise<void>,
    private readonly onError: (name: string, e: unknown) => Promise<void>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.done = (async () => {
      while (this.running) {
        try {
          await this.body(() => !this.running);
        } catch (e) {
          await this.onError(this.name, e);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.done;
  }
}
