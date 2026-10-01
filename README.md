# 💌 Remindly

A tiny app for two. Each of you picks a side (**Her** or **Him**) when you open it, adds the things you want and how badly, and the *other* phone gets a notification.

- Three lists: 🎁 **Wishes** (things to buy), ✈️ **Travel** (places and trips) and 🛋️ **Home** (furniture and ideas for your place). Travel and Home are idea lists, not shopping.
- Four urgency levels: 🙂 Whenever · 🙏 Soon-ish · 🔥 Really want · 🚨 NEED IT
- Filter each list by Open / Done and Both / Hers / His
- Optional note and link per item, "Got it" / "Been there" / "Done" to tick things off
- Notifications go to the other side only: her phone hears about his additions, his about hers (Web Push, works as a home-screen app on Android and iPhone)
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

## Set up both phones

Do this on each phone:

1. Open the app URL, enter the PIN, pick **Her** or **Him**, and type your name.
2. **iPhone:** Share → *Add to Home Screen*, then open Remindly from the home screen. (iOS only allows notifications for installed web apps.)
   **Android:** Chrome will offer *Install app*; either way works.
3. Go to **Settings** → **Notify me on this device** → allow notifications.
4. Tap **Send test**. You should get a ping within a second or two.

From then on, whatever she adds pings his phone and whatever he adds pings hers. You can change your side later under Settings → *Change who I am*.

## Optional: Telegram instead of / as well as push

If push is fiddly on your phone, Telegram is the most reliable channel:

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Send your new bot any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Every notification is then also sent to the Telegram chat, whichever side it was meant for (Telegram is one chat, so it cannot be split per person).

## How it works

- `server.js`: Express API + static files. Items and push subscriptions are saved to `DATA_DIR/items.json` and `DATA_DIR/subscriptions.json` (atomic writes).
- `public/`: the app. Plain HTML/CSS/JS, no build step. `sw.js` is the service worker that shows push notifications and caches the shell for offline.
- Every item has a `category` (`wish`, `travel`, `home`) and the `role` of whoever added it (`her`, `him`). Push subscriptions carry a role too; a notification for one side is only delivered to that side's devices.
- A notification is sent to the other side when an item is added, when an open item is bumped to a higher urgency, and (if `REMINDER_HOUR` is set) once a day listing the other person's open 🔥/🚨 items.
- `public/icons.js` holds the Lucide icons the UI uses, extracted from the Iconify icon-sets repo by `npm run icons:extract`.
- Expired push subscriptions are removed automatically when the push service reports them gone.

## API

All routes except `GET /api/config` require the `x-pin` header when `APP_PIN` is set.

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/api/config` | – |
| `GET` | `/api/items` | – |
| `POST` | `/api/items` | `{ title, urgency, category?, role?, note?, link?, addedBy? }` |
| `PATCH` | `/api/items/:id` | any of `{ done, urgency, title, note, link }` |
| `DELETE` | `/api/items/:id` | – |
| `POST` | `/api/subscribe` | a `PushSubscription` JSON plus `role` |
| `DELETE` | `/api/subscribe` | `{ endpoint }` |
| `POST` | `/api/test-notification` | `{ role? }` (sent to that side's devices) |

## Tests

```bash
npm test
```
