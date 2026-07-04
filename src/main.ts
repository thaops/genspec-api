import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

// Never let a stray async rejection (e.g. a streaming SDK parse error) kill the API.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Conversations carry full proposals (actions + trace) — default 100kb JSON
  // limit rejects them with PayloadTooLargeError once a thread grows.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      // Allow non-browser/SSR (no Origin), any localhost/127.0.0.1 port (dev),
      // and the configured FRONTEND_URL origins (prod). Reflects the request origin.
      if (!origin) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`GenSpec API listening on http://localhost:${port}`);
}
void bootstrap();
