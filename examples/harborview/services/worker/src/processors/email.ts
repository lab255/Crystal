import type { SendEmailJob } from "@harborview/queue";
import { renderTemplate } from "../templates";

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

function subjectFor(template: string): string {
  switch (template) {
    case "booking_confirmation":
      return "Your Harborview booking is confirmed";
    case "payment_failed":
      return "Payment problem with your Harborview booking";
    default:
      return "Harborview notification";
  }
}

export async function sendEmail(job: SendEmailJob, mailer: Mailer): Promise<void> {
  const body = renderTemplate(job.template, job.data);
  const subject = subjectFor(job.template);
  await mailer.send(job.to, subject, body);
}
