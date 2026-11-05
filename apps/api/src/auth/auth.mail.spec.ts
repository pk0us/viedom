import { AuthMail } from './auth.mail.js';
import { Configuration } from '../configuration.js';
import nodemailer from 'nodemailer';

it.each([false, true])(
  'requires production SMTP TLS with implicit TLS=%s and sends only a fixed fragment link',
  async (secure) => {
    const sendMail = vi.fn().mockResolvedValue({});
    const close = vi.fn();
    const transport = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close } as unknown as ReturnType<
        typeof nodemailer.createTransport
      >);
    try {
      const mail = new AuthMail({
        values: {
          mode: 'production',
          webOrigin: 'https://viedom.example',
          mail: {
            host: 'smtp.example',
            port: secure ? 465 : 587,
            secure,
            user: 'synthetic',
            password: 'SYNTHETIC_SMTP_SECRET',
            from: 'sender@viedom.example'
          }
        }
      } as Configuration);
      await mail.send('recipient@example.invalid', 'reset-password', 'T'.repeat(43));
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          secure,
          requireTLS: true,
          disableFileAccess: true,
          disableUrlAccess: true,
          logger: false,
          debug: false
        })
      );
      const message = sendMail.mock.calls[0]![0];
      expect(message.text).toContain(
        `https://viedom.example/auth/reset-password#token=${'T'.repeat(43)}`
      );
      expect(message.text).not.toContain('SYNTHETIC_SMTP_SECRET');
      expect(message).not.toHaveProperty('html');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      transport.mockRestore();
    }
  }
);
