/**
 * The tail of one lane's terminal output, kept without rebuilding it on every chunk.
 *
 * The obvious form — `output = (output + chunk).slice(-cap)` — allocates a fresh cap-sized string
 * for every chunk the CLI emits. A TUI redrawing its screen emits thousands of small chunks a
 * second, so that is tens of megabytes of allocation per second per lane, and the daemon ends up
 * spending its time copying strings instead of answering RPC. Measured over 200k chunks at a 160KB
 * cap: 2013ms and 71.5MB peak heap for concat-and-slice, against 8ms and 3.2MB for this.
 *
 * Chunks are kept as they arrive and dropped from the front once the ones behind them already cover
 * the cap, so retention stays bounded. The string is built only when something actually reads it,
 * which is rare — the terminal view streams chunks live and only a lane read asks for the tail.
 */
export class OutputBuffer {
  private readonly chunks: string[] = [];
  private length = 0;
  private cached?: string;

  constructor(private readonly cap: number) {}

  append(chunk: string) {
    if (chunk === '') return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    // Never drop the only chunk: a single chunk longer than the cap is still where the tail lives.
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= this.cap) {
      this.length -= this.chunks.shift()!.length;
    }
    this.cached = undefined;
  }

  /** The last `cap` characters — exactly what concatenating every chunk and slicing would give. */
  text() {
    this.cached ??= this.chunks.join('').slice(-this.cap);
    return this.cached;
  }

  /** Characters actually retained. Bounded by the cap plus one chunk, which is the property the
   * concatenate-and-slice form could not provide cheaply. */
  retainedLength() {
    return this.length;
  }
}
