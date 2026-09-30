// Prints a fresh VAPID key pair. Paste the values into your .env / hosting env vars.
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("Add these to your environment (never commit the private key):\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
