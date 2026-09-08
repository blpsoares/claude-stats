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
import { getMemberNameMap, listMachines } from './team-tokens'
import { sessionCostUSD } from './member-metrics'
import { dataTeamIdsOf } from './team-scope'
import { centralTaskBoard, type CentralTaskMachine, type MachineScope } from './team-task-view'
import type { Principal } from './iam-types'
import type { SessionMeta } from '@agentistics/core'

export interface CentralTaskReply {
  machines: CentralTaskMachine[]
}

/**
 * The board, scoped to what this viewer may read.
 *
 * A delivery is the most readable data on a central — a title, a description, comment bodies — so
 * it is scoped by the SAME rule `/api/data` applies to the sessions those deliveries are measured
 * from, rather than by a new one: an owner sees every machine; anyone else sees the machines of the
 * teams they MANAGE plus the machines they own. A second visibility model for the same question is
 * a second place for it to be answered differently.
 *
 * A `null` principal is the local, single-user case (this route only exists on a central, where the
 * auth gate has already refused an anonymous caller) and is scoped like a non-owner with nothing:
 * fail closed.
 */
export async function buildCentralTaskBoard(principal: Principal | null): Promise<CentralTaskReply> {
  const [nameMap, sessions, machines] = await Promise.all([
    getMemberNameMap().catch(() => ({} as Record<string, string>)),
    loadTeamSessionsFromMongo().catch(() => [] as SessionMeta[]),
    listMachines().catch(() => []),
  ])
  const tasks = await loadAllTeamTasks(nameMap).catch(() => [])
  const metas = new Map<string, SessionMeta>()
  for (const s of sessions) if (s.session_id) metas.set(s.session_id, s)

  const scope: MachineScope | null = principal?.role === 'owner'
    ? null
    : {
      teams: principal ? dataTeamIdsOf(principal) : new Set<string>(),
      owned: new Set(
        principal
          ? machines.filter(m => m.accountIds.includes(principal.accountId)).map(m => m.id)
          : [],
      ),
    }

  return {
    machines: centralTaskBoard({
      tasks,
      machines: machines.map(m => ({
        memberId: m.id,
        user: nameMap[m.id] ?? m.user,
        teamIds: m.effectiveTeamIds ?? m.teamIds ?? [],
      })),
      metas,
      costOf: sessionCostUSD,
      scope,
    }),
  }
}
