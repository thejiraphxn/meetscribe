import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import type { ProjectDTO } from '@meetscribe/shared';
import { prisma } from '../lib/prisma.js';
import { AppError, sendOk } from '../lib/http.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

export const projectsRouter: Router = Router();

projectsRouter.use(requireAuth);

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDTO(p: ProjectRow, sessionCount?: number): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...(sessionCount !== undefined ? { sessionCount } : {}),
  };
}

// GET /api/v1/projects → list the user's (non-deleted) projects.
projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const projects = await prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { sessions: true } } },
    });
    sendOk(
      res,
      projects.map((p) => toDTO(p, p._count.sessions)),
    );
  }),
);

// POST /api/v1/projects → create.
projectsRouter.post(
  '/',
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('description').optional().isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw AppError.badRequest('Validation failed', fieldErrors(errors.array()));
    }
    const { userId } = req as AuthedRequest;
    const project = await prisma.project.create({
      data: {
        userId,
        name: (req.body.name as string).trim(),
        description: (req.body.description as string | undefined) ?? null,
      },
    });
    sendOk(res, toDTO(project), 201);
  }),
);

// GET /api/v1/projects/:id → single project + session count.
projectsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId, deletedAt: null },
      include: { _count: { select: { sessions: true } } },
    });
    if (!project) throw AppError.notFound('Project not found');
    sendOk(res, toDTO(project, project._count.sessions));
  }),
);

// PATCH /api/v1/projects/:id → update name/description.
projectsRouter.patch(
  '/:id',
  body('name').optional().isString().trim().notEmpty(),
  body('description').optional({ nullable: true }).isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw AppError.badRequest('Validation failed', fieldErrors(errors.array()));
    }
    const { userId } = req as AuthedRequest;
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Project not found');

    const data: { name?: string; description?: string | null } = {};
    if (typeof req.body.name === 'string') data.name = req.body.name.trim();
    if ('description' in req.body) data.description = req.body.description ?? null;

    const project = await prisma.project.update({ where: { id: existing.id }, data });
    sendOk(res, toDTO(project));
  }),
);

// DELETE /api/v1/projects/:id → soft delete.
projectsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const existing = await prisma.project.findFirst({
      where: { id: req.params.id, userId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('Project not found');
    await prisma.project.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    sendOk(res, { deleted: true });
  }),
);

function fieldErrors(
  arr: Array<{ type: string; path?: string; msg: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of arr) {
    if (e.path) out[e.path] = e.msg;
  }
  return out;
}
