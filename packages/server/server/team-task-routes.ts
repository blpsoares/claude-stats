/**
 * team-task-routes.ts — `GET /api/team/tasks`, the central's read of the delivery boards.
 *
 * A separate route rather than a branch inside `/api/tasks` on purpose: that one is registered in
 * `capability-guard.ts` as `localShell` precisely because the board is a LOCAL store that spawns
 * and reads things on the host, and widening it to also mean "team data on a central" would blur
 * the one line that guard draws. The central's board is team data and comes through the team
 * surface, where every route is authenticated by default (`AUTH_PUBLIC` in `index-routes.ts`).
 *
 * It is READ-ONLY, and there is no write path at all. The board lives on the machine that owns it;
 * a status changed here would have nowhere to land, and a central that could edit somebody's board
 * would be a central that can edit their machine.
 */

import { loadAllTeamTasks } from './team-tasks'
import { loadTeamSessionsFromMongo } from './team-source'
import { getMemberNameMap, listMembers } from './team-tokens'
import { sessionCostUSD } from './member-metrics'
import { centralTaskBoard, type CentralTaskMachine } from './team-task-view'
import type { SessionMeta } from '@agentistics/core'

export interface CentralTaskReply {
  machines: CentralTaskMachine[]
}

export async function buildCentralTaskBoard(): Promise<CentralTaskReply> {
  const [nameMap, sessions, members] = await Promise.all([
    getMemberNameMap().catch(() => ({} as Record<string, string>)),
    loadTeamSessionsFromMongo().catch(() => [] as SessionMeta[]),
    listMembers().catch(() => []),
  ])
  const tasks = await loadAllTeamTasks(nameMap).catch(() => [])
  const metas = new Map<string, SessionMeta>()
  for (const s of sessions) if (s.session_id) metas.set(s.session_id, s)
  return {
    machines: centralTaskBoard({
      tasks,
      machines: members.map(m => ({ memberId: m.id, user: nameMap[m.id] ?? m.user })),
      metas,
      costOf: sessionCostUSD,
    }),
  }
}
