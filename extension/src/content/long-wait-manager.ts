export interface LongWaitPresenter {
  show: () => void;
  hide: () => void;
}

export class LongWaitManager {
  private readonly pendingLongHashes = new Set<string>();
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;

  constructor(
    private readonly presenter: LongWaitPresenter,
    private readonly delayMs = 500,
  ) {}

  start(hash: string): void {
    this.pendingLongHashes.add(hash);
    this.ensureShowTimer();
  }

  handleFirstAnnotation(hash: string): void {
    if (!this.pendingLongHashes.has(hash)) return;
    this.pendingLongHashes.clear();
    this.hideNow();
  }

  handleFinalResult(hash: string, annotationCount: number): void {
    if (!this.pendingLongHashes.has(hash)) return;
    if (annotationCount > 0) {
      this.pendingLongHashes.clear();
      this.hideNow();
      return;
    }
    this.completeWithoutAnnotations(hash);
  }

  completeWithoutAnnotations(hash: string): void {
    if (!this.pendingLongHashes.delete(hash)) return;
    if (this.pendingLongHashes.size === 0) {
      this.hideNow();
    }
  }

  reset(): void {
    this.pendingLongHashes.clear();
    this.hideNow();
  }

  pendingCount(): number {
    return this.pendingLongHashes.size;
  }

  isVisible(): boolean {
    return this.visible;
  }

  private ensureShowTimer(): void {
    if (this.visible || this.showTimer || this.pendingLongHashes.size === 0) return;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      if (this.visible || this.pendingLongHashes.size === 0) return;
      this.presenter.show();
      this.visible = true;
    }, this.delayMs);
  }

  private hideNow(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (!this.visible) return;
    this.presenter.hide();
    this.visible = false;
  }
}
