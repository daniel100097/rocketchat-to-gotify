type DdpMessage = Record<string, unknown> & {
  msg?: string;
  id?: string;
  subs?: string[];
  error?: unknown;
  result?: unknown;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type DdpChangedMessage = {
  collection?: string;
  id?: string;
  fields?: {
    eventName?: string;
    args?: unknown[];
  };
};

export class DdpClient {
  private ws?: WebSocket;
  private sequence = 0;
  private connected?: PendingCall;
  private readonly pending = new Map<string, PendingCall>();
  private readonly ready = new Map<string, PendingCall>();
  private readonly debugEnabled = Bun.env.DEBUG === "true";

  constructor(
    private readonly url: string,
    private readonly onChanged: (message: DdpChangedMessage) => void
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.connected = {
        resolve: () => resolve(),
        reject
      };

      ws.addEventListener("open", () => {
        this.debug("websocket open");
        this.send({ msg: "connect", version: "1", support: ["1", "pre2", "pre1"] });
      });

      ws.addEventListener("message", (event) => {
        for (const message of decodeDdpFrames(event.data)) {
          this.debug("recv", messageSummary(message));
          this.handle(message);
        }
      });

      ws.addEventListener("error", () => {
        this.debug("websocket error");
        reject(new Error("Rocket.Chat realtime websocket failed."));
      });

      ws.addEventListener("close", () => {
        this.debug("websocket close");
        const error = new Error("Rocket.Chat realtime websocket closed.");
        this.connected?.reject(error);
        this.rejectAll(error);
      });
    });
  }

  call(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.debug("send method", { id, method });
    this.send({ msg: "method", id, method, params });
    return promise;
  }

  subscribe(name: string, params: unknown[]): Promise<void> {
    const id = this.nextId();
    const promise = new Promise<void>((resolve, reject) => {
      this.ready.set(id, {
        resolve: () => resolve(),
        reject
      });
    });
    this.debug("send sub", { id, name, params });
    this.send({ msg: "sub", id, name, params });
    return promise;
  }

  close(): void {
    this.ws?.close();
  }

  private handle(message: DdpMessage): void {
    if (message.msg === "connected") {
      this.connected?.resolve(undefined);
      this.connected = undefined;
      return;
    }

    if (message.msg === "ping") {
      this.send(message.id ? { msg: "pong", id: message.id } : { msg: "pong" });
      return;
    }

    if (message.msg === "result" && message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (pending) {
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      }

      return;
    }

    if (message.msg === "ready") {
      for (const id of message.subs ?? []) {
        const pending = this.ready.get(id);
        this.ready.delete(id);
        pending?.resolve(undefined);
      }

      return;
    }

    if (message.msg === "nosub" && message.id) {
      const pending = this.ready.get(message.id);
      this.ready.delete(message.id);
      pending?.reject(new Error(message.error ? JSON.stringify(message.error) : "Subscription failed."));
      return;
    }

    if (message.msg === "changed") {
      this.onChanged(message as DdpChangedMessage);
    }
  }

  private send(message: Record<string, unknown>): void {
    this.debug("send", messageSummary(message));
    this.ws?.send(JSON.stringify(message));
  }

  private nextId(): string {
    this.sequence += 1;
    return String(this.sequence);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    for (const pending of this.ready.values()) {
      pending.reject(error);
    }

    this.pending.clear();
    this.ready.clear();
  }

  private debug(message: string, data?: unknown): void {
    if (!this.debugEnabled) {
      return;
    }

    console.log(`[debug:ddp] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
  }
}

function messageSummary(message: Record<string, unknown>): Record<string, unknown> {
  return {
    msg: message.msg,
    id: message.id,
    method: message.method,
    collection: message.collection,
    error: summarizeError(message.error),
    subs: message.subs
  };
}

function summarizeError(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }

  const input = error as Record<string, unknown>;
  return {
    error: input.error,
    reason: input.reason,
    details: input.details
  };
}

function decodeDdpFrames(data: unknown): DdpMessage[] {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : String(data);

  if (text === "o" || text === "h") {
    return [];
  }

  if (text.startsWith("a[")) {
    const frames = JSON.parse(text.slice(1)) as string[];
    return frames.map((frame) => JSON.parse(frame) as DdpMessage);
  }

  const parsed = JSON.parse(text) as DdpMessage | string[];

  if (Array.isArray(parsed)) {
    return parsed.map((frame) => JSON.parse(frame) as DdpMessage);
  }

  return [parsed];
}
