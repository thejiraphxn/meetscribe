import type { SessionPayload, SessionDetailDTO, SessionSummaryDTO } from '@meetscribe/shared';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/http.js';

/** Verify the project belongs to the user (and is not soft-deleted). */
async function assertProjectOwnership(projectId: string, userId: string): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw AppError.notFound('Project not found');
}

/**
 * Idempotent upsert of a session synced from the desktop. Keyed by `localId`.
 * Segments are replaced wholesale (delete → re-insert) so re-syncs converge.
 */
export async function upsertSession(
  payload: SessionPayload,
  userId: string,
): Promise<SessionSummaryDTO> {
  await assertProjectOwnership(payload.projectId, userId);

  const startedAt = new Date(payload.startedAt);
  const endedAt = new Date(payload.endedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    throw AppError.badRequest('Invalid startedAt/endedAt timestamp');
  }

  const session = await prisma.$transaction(async (tx) => {
    const upserted = await tx.session.upsert({
      where: { localId: payload.localId },
      create: {
        localId: payload.localId,
        projectId: payload.projectId,
        title: payload.title ?? null,
        mode: payload.mode,
        durationSeconds: payload.durationSeconds,
        language: payload.language,
        startedAt,
        endedAt,
        notes: payload.notes ?? null,
      },
      update: {
        projectId: payload.projectId,
        title: payload.title ?? null,
        mode: payload.mode,
        durationSeconds: payload.durationSeconds,
        language: payload.language,
        startedAt,
        endedAt,
        notes: payload.notes ?? null,
      },
    });

    // Replace child rows for idempotency.
    await tx.transcriptSegment.deleteMany({ where: { sessionId: upserted.id } });
    if (payload.segments.length > 0) {
      await tx.transcriptSegment.createMany({
        data: payload.segments.map((s) => ({
          sessionId: upserted.id,
          sequence: s.sequence,
          startSec: s.startSec,
          endSec: s.endSec ?? null,
          text: s.text,
          speaker: s.speaker ?? null,
          confidence: s.confidence ?? null,
          isFinal: true,
        })),
      });
    }

    await tx.actionItem.deleteMany({ where: { sessionId: upserted.id } });
    if (payload.actionItems.length > 0) {
      await tx.actionItem.createMany({
        data: payload.actionItems.map((a) => ({
          sessionId: upserted.id,
          text: a.text,
          assignee: a.assignee ?? null,
        })),
      });
    }

    return upserted;
  });

  return toSummary(session);
}

interface SessionRow {
  id: string;
  localId: string;
  projectId: string;
  title: string | null;
  mode: 'realtime' | 'batch';
  durationSeconds: number;
  language: string;
  startedAt: Date;
  endedAt: Date;
  createdAt: Date;
}

function toSummary(s: SessionRow): SessionSummaryDTO {
  return {
    id: s.id,
    localId: s.localId,
    projectId: s.projectId,
    title: s.title,
    mode: s.mode,
    durationSeconds: s.durationSeconds,
    language: s.language,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  };
}

export interface ListParams {
  userId: string;
  projectId?: string;
  limit: number;
  cursor?: string;
}

export async function listSessions(
  params: ListParams,
): Promise<{ items: SessionSummaryDTO[]; nextCursor: string | null }> {
  const { userId, projectId, limit, cursor } = params;
  const rows = await prisma.session.findMany({
    where: {
      project: { userId, deletedAt: null },
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toSummary),
    nextCursor: hasMore && last ? last.id : null,
  };
}

export async function getSessionDetail(
  sessionId: string,
  userId: string,
): Promise<SessionDetailDTO> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, project: { userId, deletedAt: null } },
    include: {
      segments: { orderBy: { sequence: 'asc' } },
      actionItems: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!session) throw AppError.notFound('Session not found');

  return {
    ...toSummary(session),
    notes: session.notes,
    segments: session.segments.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      startSec: s.startSec,
      endSec: s.endSec ?? undefined,
      text: s.text,
      speaker: s.speaker ?? undefined,
      confidence: s.confidence ?? undefined,
      isFinal: s.isFinal,
    })),
    actionItems: session.actionItems.map((a) => ({
      id: a.id,
      text: a.text,
      assignee: a.assignee ?? undefined,
      done: a.done,
    })),
  };
}

export async function toggleActionItem(
  sessionId: string,
  actionItemId: string,
  userId: string,
): Promise<{ id: string; done: boolean }> {
  const item = await prisma.actionItem.findFirst({
    where: { id: actionItemId, sessionId, session: { project: { userId } } },
  });
  if (!item) throw AppError.notFound('Action item not found');
  const updated = await prisma.actionItem.update({
    where: { id: item.id },
    data: { done: !item.done },
  });
  return { id: updated.id, done: updated.done };
}

export async function deleteSession(sessionId: string, userId: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, project: { userId } },
    select: { id: true },
  });
  if (!session) throw AppError.notFound('Session not found');
  await prisma.session.delete({ where: { id: session.id } });
}
