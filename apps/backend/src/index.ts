import express from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { sendError } from './lib/http.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { sessionsRouter } from './routes/sessions.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' })); // transcripts can be large

app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/sessions', sessionsRouter);

// 404 fallback.
app.use((_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Route not found');
});

app.use(errorHandler);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MeetScribe API listening on :${env.PORT} (${env.NODE_ENV})`);
});
