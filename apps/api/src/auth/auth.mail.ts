import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { Configuration } from '../configuration.js';
import type { ActionPurpose } from './auth.schema.js';

/** SMTP adapter: tests replace this provider; production requires authenticated TLS. */
@Injectable()
export class AuthMail {
  constructor(private readonly configuration: Configuration) {}

  async send(to: string, purpose: ActionPurpose, token: string): Promise<void> {
    const { mail, webOrigin, mode } = this.configuration.values;
    const transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      requireTLS: mode === 'production',
      ...(mail.user ? { auth: { user: mail.user, pass: mail.password } } : {}),
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false
    });
    const verification = purpose === 'verify-email';
    // Fragment stays out of HTTP request URLs, SSR, proxy logs and referrers.
    const link = `${webOrigin}/auth/${purpose}#token=${token}`;
    try {
      await transport.sendMail({
        from: mail.from,
        to: { address: to, name: '' },
        subject: verification ? 'Verify your Viedom email' : 'Reset your Viedom password',
        text:
          `${verification ? 'Verify your email address' : 'Reset your password'}:\n\n${link}\n\n` +
          `This link can be used once and expires in ${verification ? '24 hours' : '30 minutes'}.\n` +
          'If you did not request this, you can ignore this email.'
      });
    } finally {
      transport.close();
    }
  }
}
