import { DdpClient, type DdpChangedMessage } from "./ddp-client";

type Room = {
  rid: string;
  t: string;
  name?: string;
  fname?: string | null;
};

type Message = {
  _id: string;
  rid: string;
  msg?: string;
  t?: string;
  bot?: boolean;
  u?: {
    _id?: string;
    username?: string;
    name?: string;
  };
};

const rocketChatEndpoint = requiredEnv("ROCKETCHAT_ENDPOINT").replace(/\/+$/, "");
const userId = requiredEnv("ROCKETCHAT_USER_ID");
const authToken = requiredEnv("ROCKETCHAT_AUTH_TOKEN");
const webhookEndpoint = requiredEnv("WEBHOOK_ENDPOINT");
const ignoreSelf = envFlag("IGNORE_SELF", true);
const ignoreBots = envFlag("IGNORE_BOTS", true);
const debugEnabled = envFlag("DEBUG", false);
const hideDetails = envFlag("HIDE_DETAILS", false);
const gotifyPriority = Number(Bun.env.GOTIFY_PRIORITY ?? "5");
const subscribeDelayMs = 1500;
const roomFilter = parseList(Bun.env.ROOMS);
const seen = new Set<string>();

debug("loading rooms");
const rooms = filterRooms(await getRooms());
const roomsById = new Map(rooms.map((room) => [room.rid, room]));
const wsEndpoint = websocketEndpoint(rocketChatEndpoint);
const client = new DdpClient(wsEndpoint, (changed) => {
  void handleChanged(changed).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
  });
});

debug("connecting websocket", { endpoint: wsEndpoint });
await client.connect();
debug("resuming Rocket.Chat session");
await client.call("login", [{ resume: authToken }]);
debug("session resumed");

for (const [index, room] of rooms.entries()) {
  await subscribeToRoom(room, index + 1, rooms.length);
}

console.log(`Watching ${rooms.length} Rocket.Chat rooms.`);

await new Promise(() => undefined);

async function getRooms(): Promise<Room[]> {
  const response = await fetch(new URL("/api/v1/subscriptions.get", rocketChatEndpoint), {
    headers: {
      "x-user-id": userId,
      "x-auth-token": authToken
    }
  });
  const body = (await response.json()) as { update?: Room[]; success?: boolean; error?: string };

  if (!response.ok || body.success === false) {
    throw new Error(body.error ?? `Could not load rooms: ${response.status} ${response.statusText}`);
  }

  const rooms = (body.update ?? []).filter((room) => room.rid && (room.t === "c" || room.t === "p" || room.t === "d"));
  debug("loaded rooms", { count: rooms.length, rooms: rooms.map(roomLabel) });
  return rooms;
}

function filterRooms(rooms: Room[]): Room[] {
  if (roomFilter.length === 0) {
    return rooms;
  }

  const filtered = rooms.filter((room) => roomKeys(room).some((key) => roomFilter.includes(key)));

  if (filtered.length === 0) {
    throw new Error(`ROOMS did not match any rooms. Available rooms: ${rooms.map(roomLabel).join(", ")}`);
  }

  debug("filtered rooms", { requested: roomFilter, count: filtered.length, rooms: filtered.map(roomLabel) });
  return filtered;
}

async function subscribeToRoom(room: Room, index: number, total: number): Promise<void> {
  while (true) {
    try {
      debug("subscribing room", { progress: `${index}/${total}`, room: roomLabel(room), rid: room.rid });
      await client.subscribe("stream-room-messages", [room.rid, false]);
      debug("subscribed room", { progress: `${index}/${total}`, room: roomLabel(room), rid: room.rid });
      await sleep(subscribeDelayMs);
      return;
    } catch (error) {
      const waitMs = rateLimitWaitMs(error);

      if (!waitMs) {
        throw error;
      }

      console.log(`Rocket.Chat rate limit while subscribing to ${roomLabel(room)}. Waiting ${Math.ceil(waitMs / 1000)}s.`);
      debug("subscription rate limited", { room: roomLabel(room), rid: room.rid, waitMs });
      await sleep(waitMs + 1000);
    }
  }
}

async function handleChanged(changed: DdpChangedMessage): Promise<void> {
  if (changed.collection !== "stream-room-messages") {
    return;
  }

  const message = readMessage(changed);

  if (!message || !shouldNotify(message)) {
    return;
  }

  const room = roomsById.get(message.rid);

  if (!room) {
    debug("ignored message", { messageId: message._id, reason: "unknown room", rid: message.rid });
    return;
  }

  await sendWebhook(room, message);
  seen.add(message._id);
  console.log(hideDetails ? `Sent ${messageType(message)} notification.` : `Sent notification for ${roomLabel(room)} message ${message._id}`);
}

function readMessage(changed: DdpChangedMessage): Message | undefined {
  const candidate = (changed.fields?.args ?? []).find(isRecord);

  if (!candidate) {
    return undefined;
  }

  const id = readString(candidate, "_id");
  const roomId = readString(candidate, "rid") ?? changed.fields?.eventName;

  if (!id || !roomId) {
    return undefined;
  }

  const user = readRecord(candidate, "u");

  return {
    _id: id,
    rid: roomId,
    msg: readString(candidate, "msg"),
    t: readString(candidate, "t"),
    bot: candidate.bot === true,
    u: user
      ? {
          _id: readString(user, "_id"),
          username: readString(user, "username"),
          name: readString(user, "name")
        }
      : undefined
  };
}

function shouldNotify(message: Message): boolean {
  if ((!message.msg?.trim() && !message.t) || seen.has(message._id)) {
    debug("ignored message", {
      messageId: message._id,
      reason: seen.has(message._id) ? "already seen" : "empty text"
    });
    return false;
  }

  if (ignoreSelf && message.u?._id === userId) {
    debug("ignored message", { messageId: message._id, reason: "self" });
    return false;
  }

  if (ignoreBots && message.bot) {
    debug("ignored message", { messageId: message._id, reason: "bot" });
    return false;
  }

  return true;
}

async function sendWebhook(room: Room, message: Message): Promise<void> {
  const sender = message.u?.username ?? message.u?.name ?? "Unknown user";
  debug("sending webhook", {
    room: roomLabel(room),
    messageId: hideDetails ? undefined : message._id,
    sender: hideDetails ? undefined : sender,
    type: messageType(message)
  });
  const payload = hideDetails
    ? {
        title: "Rocket.Chat",
        message: messageType(message),
        priority: gotifyPriority
      }
    : {
        title: `Rocket.Chat ${roomLabel(room)}`,
        message: `${sender}: ${message.msg}`,
        priority: gotifyPriority,
        extras: {
          "client::display": {
            contentType: "text/plain"
          },
          rocketchat: {
            source: "rocketchat",
            type: messageType(message),
            room: roomLabel(room),
            roomId: room.rid,
            messageId: message._id,
            sender,
            senderUserId: message.u?._id
          }
        }
      };
  const response = await fetch(webhookEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
  }

  debug("webhook sent", {
    room: roomLabel(room),
    messageId: hideDetails ? undefined : message._id,
    status: response.status
  });
}

function websocketEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/websocket";
  url.search = "";
  return url.toString();
}

function roomLabel(room: Room): string {
  const name = room.fname ?? room.name ?? room.rid;
  return room.t === "d" ? name : `#${name}`;
}

function messageType(message: Message): string {
  return message.t ?? "message";
}

function roomKeys(room: Room): string[] {
  return [room.rid, room.name, room.fname, roomLabel(room)]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [normalizeRoom(value), normalizeRoom(value.replace(/^#/, ""))]);
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];

  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }

  return value;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = Bun.env[name];
  return value ? value !== "false" : defaultValue;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(normalizeRoom)
    .filter(Boolean);
}

function normalizeRoom(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function debug(message: string, data?: unknown): void {
  if (!debugEnabled) {
    return;
  }

  console.log(`[debug] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
}

function rateLimitWaitMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(message) as { error?: string; details?: { timeToReset?: number }; reason?: string };

    if (parsed.error === "too-many-requests" || parsed.reason?.includes("too many requests")) {
      return parsed.details?.timeToReset ?? 60000;
    }
  } catch {
    const match = message.match(/wait (\d+) seconds/i);

    if (match?.[1]) {
      return Number(match[1]) * 1000;
    }
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readRecord(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  return isRecord(value) ? value : undefined;
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
