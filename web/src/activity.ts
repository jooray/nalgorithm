/** Idempotent named blockers: overlapping work cannot unblock another task. */
export class ActivityGate {
  private readonly tasks = new Map<symbol, string>()
  begin(name: string): () => void {
    const token = Symbol(name)
    this.tasks.set(token, name)
    return () => { this.tasks.delete(token) }
  }
  get blocked(): boolean { return this.tasks.size > 0 }
  get reasons(): string[] { return [...new Set(this.tasks.values())] }
}
export const activities = new ActivityGate()
export const beginActivity = (name: string): (() => void) => activities.begin(name)
