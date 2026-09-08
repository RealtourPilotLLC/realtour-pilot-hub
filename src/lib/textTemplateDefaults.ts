// CLIENT-SAFE on purpose: this file imports NOTHING. The Settings text boxes
// (a client component) read it, and pulling it from src/lib/settings.ts dragged
// integrations/crypto (Node's crypto) into the browser bundle — the Sep 7 deploy
// failed with 8 Turbopack errors exactly that way.
/** What the built-in wording in src/lib/delivery.ts SAYS, as a template — so the
 *  Settings boxes show the current message instead of sitting empty (Jordan,
 *  Sep 7: "current templates should show"). For DISPLAY: an empty stored
 *  template still means "use the built-in wording", which composes the same
 *  sentences but can also drop " for {items}" when a job has none. */
export const BUILTIN_TEMPLATE_TEXT: { confirmation: string; deliveryAll: string; deliveryPartial: string } = {
  confirmation: "Hi {first}! Confirming your shoot at {street} on {when} for {items}. Anything we should know or want us to avoid? Looking forward to it!",
  deliveryAll: "Hi {first}! Everything for {street} has been delivered. How did we do? If anything is not exactly right, just reply here and we will jump on it. And if you have a quick minute, we would love your feedback here: {feedbackUrl}",
  deliveryPartial: "Hi {first}! The {delivered} for {street} have been delivered, and the {remaining} are still in production and coming shortly. How is everything looking so far? If anything is not exactly right, just reply here and we will jump on it. Quick feedback means a lot to us: {feedbackUrl}",
};
