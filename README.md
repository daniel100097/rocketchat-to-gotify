# Rocket.Chat To Gotify

Simple Bun watcher:

- connects to Rocket.Chat with your browser `Meteor.loginToken`
- watches rooms your user can already access
- posts Gotify notifications for new messages

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env`:

```bash
ROCKETCHAT_ENDPOINT=https://chat.example.com
ROCKETCHAT_USER_ID=ccQSk5mBqPJPcFYRd
ROCKETCHAT_AUTH_TOKEN=your-meteor-login-token
WEBHOOK_ENDPOINT=https://gotify.example.com/message?token=your-gotify-app-token
HIDE_DETAILS=true
```

Run it:

```bash
bun run start
```

## Docker

Build and run locally:

```bash
docker build -t rocketchat-gotify .
docker run --env-file .env rocketchat-gotify
```

Or use Compose:

```bash
docker compose up -d --build
```

## GitHub Container Registry

The workflow in `.github/workflows/container.yml` builds the image on pull requests and publishes to GitHub Container Registry on pushes to `main`, `master`, and version tags like `v1.0.0`.

Published image:

```bash
ghcr.io/<owner>/<repo>:master
```

Run the published image:

```bash
docker run --env-file .env ghcr.io/<owner>/<repo>:master
```

## Browser Token

In Rocket.Chat, open DevTools Console and run:

```js
console.log({
  userId: localStorage.getItem("Meteor.userId") ?? sessionStorage.getItem("Meteor.userId"),
  authToken: localStorage.getItem("Meteor.loginToken") ?? sessionStorage.getItem("Meteor.loginToken")
});
```

Use `userId` as `ROCKETCHAT_USER_ID` and `authToken` as `ROCKETCHAT_AUTH_TOKEN`.

Treat `ROCKETCHAT_AUTH_TOKEN` like a password.

## Gotify Payload

The watcher sends this JSON to `WEBHOOK_ENDPOINT`:

```json
{
  "title": "Rocket.Chat #general",
  "message": "sam: message text",
  "priority": 5,
  "extras": {
    "client::display": {
      "contentType": "text/plain"
    },
    "rocketchat": {
      "source": "rocketchat",
      "type": "message",
      "room": "#general",
      "roomId": "room-id",
      "messageId": "message-id",
      "sender": "username",
      "senderUserId": "sender-user-id"
    }
  }
}
```

With `HIDE_DETAILS=true`, no room, user, message text, or ids are sent:

```json
{
  "title": "Rocket.Chat",
  "message": "message",
  "priority": 5
}
```

## Options

```bash
IGNORE_SELF=true
IGNORE_BOTS=true
HIDE_DETAILS=false
GOTIFY_PRIORITY=5
DEBUG=false
# ROOMS=general,IT
```

Set `HIDE_DETAILS=true` to hide room, user, message text, and all ids from Gotify. The Gotify `message` becomes `message` for normal messages or Rocket.Chat's system message type when one is present.

Set `DEBUG=true` to print connection, subscription, rate-limit, message ignore, and webhook delivery logs. The token is not printed.

Set `ROOMS` to a comma-separated list of room names or ids if you only want to watch specific rooms.
