# 💌 Remindly

A tiny shared wishlist. She adds the things she wants and how badly she wants them; your phone gets a notification.

- Four urgency levels: 🙂 Whenever · 🙏 Soon-ish · 🔥 Really want · 🚨 NEED IT
- Optional note and link per wish, "Got it" to tick things off, delete when done
- Notifications on your phone (Web Push, works as a home-screen app on Android and iPhone)
- Optional Telegram notifications too
- Optional daily reminder of open 🔥/🚨 wishes
- One shared PIN, no accounts, no database: everything lives in two JSON files

## Run it locally (2 minutes)

```bash
npm install
npm run vapid          # prints VAPID keys; copy them into .env
cp .env.example .env   # then fill in APP_PIN and the VAPID keys
npm start              # http://localhost:3000
```

`.env` is not loaded automatically. Either export the variables in your shell, set them in your host's dashboard, or run:

```bash
node --env-file=.env server.js
```

## Put it online (so her phone and yours both reach it)

Push notifications need HTTPS, so host it somewhere with a free TLS certificate. Any Node host works; [Render](https://render.com), [Railway](https://railway.app) and [Fly.io](https://fly.io) all have free or near-free tiers.

1. Push this repo to GitHub and create a new **Web Service** from it.
2. Build command: `npm install`. Start command: `npm start`.
3. Set these environment variables:

   | Variable | Value |
   | --- | --- |
   | `APP_PIN` | a short PIN you both know |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | output of `npm run vapid` |
   | `VAPID_SUBJECT` | `mailto:you@example.com` |
   | `DATA_DIR` | a path on a persistent disk, e.g. `/data` (otherwise the list resets on redeploy) |
   | `REMINDER_HOUR` | e.g. `9` for a 9am digest of open urgent wishes, or empty to turn it off |

4. Attach a small persistent disk mounted at `DATA_DIR`.

## Set up your phone

1. Open the app URL, enter the PIN and your name.
2. **iPhone:** Share → *Add to Home Screen*, then open Remindly from the home screen. (iOS only allows notifications for installed web apps.)
   **Android:** Chrome will offer *Install app*; either way works.
3. Tap ⚙️ → **Notify me on this device** → allow notifications.
4. Tap **Send test**. You should get a ping within a second or two.

Send her the same URL and PIN. She only needs to add wishes; she does not have to turn on notifications (unless she wants to know when you tick something off, which the app does not send today).

## Optional: Telegram instead of / as well as push

If push is fiddly on your phone, Telegram is the most reliable channel:

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Send your new bot any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Every notification is then sent to both push subscribers and the Telegram chat.

## How it works

- `server.js`: Express API + static files. Items and push subscriptions are saved to `DATA_DIR/items.json` and `DATA_DIR/subscriptions.json` (atomic writes).
- `public/`: the app. Plain HTML/CSS/JS, no build step. `sw.js` is the service worker that shows push notifications and caches the shell for offline.
- A notification is sent when a wish is added, when an open wish is bumped to a higher urgency, and (if `REMINDER_HOUR` is set) once a day listing open 🔥/🚨 wishes.
- Expired push subscriptions are removed automatically when the push service reports them gone.

## API

All routes except `GET /api/config` require the `x-pin` header when `APP_PIN` is set.

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/config` | – |
| `GET` | `/api/items` | – |
| `POST` | `/api/items` | `{ title, urgency, note?, link?, addedBy? }` |
| `PATCH` | `/api/items/:id` | any of `{ done, urgency, title, note, link }` |
| `DELETE` | `/api/items/:id` | – |
| `POST` | `/api/subscribe` | a `PushSubscription` JSON |
| `DELETE` | `/api/subscribe` | `{ endpoint }` |
| `POST` | `/api/test-notification` | – |

## Tests

```bash
npm test
```
