export interface OutboundMail {
  to: string;
  subject: string;
  body: string;
}

/** Fixture SMTP: log instead of sending. */
export async function sendMail(mail: OutboundMail): Promise<void> {
  console.log(`[mail] to=${mail.to} subject=${mail.subject}`);
}

/** Render a mail for eyeballing in tests/dev tools. */
export function previewMail(mail: OutboundMail): string {
  return `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.body}`;
}
