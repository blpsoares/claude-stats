/** PURE: may this machine serve a per-session utility shell?
 *
 *  A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
 *  powerful thing this server does — the chat at least spawns a NAMED assistant CLI, while this
 *  spawns whatever the person types into it. So it takes the same two gates, in the same order:
 *
 *  - `capable` is `CAPS.localShell`, decided by the exposure profile in `exposure.ts`. It is the
 *    SECURITY answer.
 *  - `preference` is the user's own switch, and it may only ever NARROW. A preference that could
 *    re-enable what `public` denied would be an opt-in restoring host power on an exposed instance,
 *    which `exposure.ts` exists to make impossible.
 *
 *  Absent reads as OFF, for the reason `chatAllowed` gives and with more force: treating absence as
 *  ON would leave a shell open in the browser of every machine nobody has touched since the
 *  upgrade. The cost of the strict reading is a switch to flip in Settings; the cost of the lenient
 *  one is a shell nobody chose.
 *
 *  It is a SEPARATE switch from `chatEnabled`, not a reuse of it: they are different powers, and
 *  somebody who wants to talk to an assistant through the dashboard has not thereby asked for a
 *  shell on the host. */
export function shellAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference === true
}
