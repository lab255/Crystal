import { formatCurrency } from "./format";

export interface TemplateContext {
  [key: string]: unknown;
}

const TEMPLATES: Record<string, (ctx: TemplateContext) => string> = {
  booking_confirmation: (ctx) =>
    "Your booking " +
    ctx.bookingId +
    " is confirmed. Total charged: " +
    formatCurrency(Number(ctx.totalCents), "USD") +
    ". Bon voyage!",
  payment_failed: (ctx) =>
    "We could not capture payment for booking " +
    ctx.bookingId +
    ". Please update your card to keep your seats.",
};

export function renderTemplate(name: string, ctx: TemplateContext): string {
  const template = TEMPLATES[name];
  if (!template) {
    throw new Error("unknown template: " + name);
  }
  return template(ctx);
}
