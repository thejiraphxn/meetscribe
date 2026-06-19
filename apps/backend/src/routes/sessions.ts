import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import type { SessionPayload } from '@meetscribe/shared';
import { AppError, sendOk } from '../lib/http.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import {
  deleteSession,
  getSessionDetail,
  listSessions,
  toggleActionItem,
  upsertSession,
} from '../services/sessionService.js';

export const sessionsRouter: Router = Router();

sessionsRouter.use(requireAuth);

// POST /api/v1/sessions → sync (upsert by localId).
sessionsRouter.post(
  '/',
  body('localId').isString().notEmpty(),
  body('projectId').isString().notEmpty(),
  body('mode').isIn(['realtime', 'batch']),
  body('durationSeconds').isInt({ min: 0 }),
  body('language').isString().notEmpty(),
  body('startedAt').isISO8601(),
  body('endedAt').isISO8601(),
  body('segments').isArray(),
  body('actionItems').isArray(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw AppError.badRequest('Validation failed', fieldErrors(errors.array()));
    }
    const { userId } = req as AuthedRequest;
    const summary = await upsertSession(req.body as SessionPayload, userId);
    sendOk(res, summary, 201);
  }),
);

// GET /api/v1/sessions?projectId=&limit=20&cursor=
sessionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

    const result = await listSessions({ userId, projectId, limit, cursor });
    sendOk(res, result);
  }),
);

// GET /api/v1/sessions/:id → detail with segments + action items.
sessionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const detail = await getSessionDetail(requireParam(req.params.id, 'id'), userId);
    sendOk(res, detail);
  }),
);

// PATCH /api/v1/sessions/:id/action-items/:aiId → toggle done.
sessionsRouter.patch(
  '/:id/action-items/:aiId',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const result = await toggleActionItem(
      requireParam(req.params.id, 'id'),
      requireParam(req.params.aiId, 'aiId'),
      userId,
    );
    sendOk(res, result);
  }),
);

// DELETE /api/v1/sessions/:id
sessionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    await deleteSession(requireParam(req.params.id, 'id'), userId);
    sendOk(res, { deleted: true });
  }),
);

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw AppError.badRequest(`Missing route parameter: ${name}`);
  return value;
}

function fieldErrors(
  arr: Array<{ type: string; path?: string; msg: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of arr) {
    if (e.path) out[e.path] = e.msg;
  }
  return out;
}
